import { generateText, isStepCount, type ModelMessage } from 'ai'
import type { Logger } from '../lib/logger.js'
import type { UserService } from '../core/users.js'
import type { TaskService } from '../tasks/service.js'
import type { Clock } from '../tasks/time.js'
import { buildInstructions } from './context.js'
import type { NamedModel } from './providers.js'
import { buildTools, READ_ONLY_TOOLS } from './tools.js'
import {
  AssistantUnavailableError,
  type Assistant,
  type AssistantInput,
  type AssistantOutput,
  type ToolCallRecord,
} from './types.js'

const MAX_STEPS = 8
/** Per model; long enough to wait out a short rate-limit window (providers send retry-after). */
const TIMEOUT_MS = 45_000
const MAX_RETRIES = 2

type Deps = {
  models: NamedModel[]
  tasks: TaskService
  users: UserService
  clock: Clock
  logger: Logger
}

/** LLM assistant: one tool-calling loop per message, with model fallback. */
export class LlmAssistant implements Assistant {
  constructor(private readonly deps: Deps) {}

  async reply({ user, text, history }: AssistantInput): Promise<AssistantOutput> {
    const { models, tasks, users, clock, logger } = this.deps
    const zone = users.zoneOf(user)
    const openTasks = await tasks.list(user.id, { status: 'open', limit: 40 })
    const instructions = buildInstructions({ user, zone, now: clock(), openTasks })
    const messages: ModelMessage[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content }) as ModelMessage),
      { role: 'user', content: text },
    ]

    let lastError: unknown
    for (const { ref, model } of models) {
      // Tool results of this attempt, so a mid-loop failure can still report what was saved.
      const done: ToolCallRecord[] = []
      let changedSomething = false
      try {
        const result = await generateText({
          model,
          instructions,
          messages,
          tools: buildTools({
            tasks,
            users,
            user,
            zone,
            clock,
            onToolStart: (name) => (changedSomething ||= !READ_ONLY_TOOLS.has(name)),
            onToolResult: (record) => done.push(record),
          }),
          stopWhen: isStepCount(MAX_STEPS),
          maxRetries: MAX_RETRIES,
          abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        })
        const toolCalls = collectToolCalls(result.steps)
        return { text: result.text.trim() || fallbackText(toolCalls), toolCalls, model: ref }
      } catch (err) {
        lastError = err
        logger.warn({ err, model: ref, changedSomething }, 'LLM call failed')
        // Never hand a half-done turn to another model: it would repeat the changes.
        // Confirm what was saved instead of telling the user to try again.
        if (changedSomething) return { text: summarize(done), toolCalls: done, model: `${ref} (interrupted)` }
      }
    }
    throw new AssistantUnavailableError(lastError)
  }
}

type StepLike = {
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  toolResults: Array<{ toolCallId: string; output: unknown }>
}

function collectToolCalls(steps: StepLike[]): ToolCallRecord[] {
  return steps.flatMap((step) =>
    step.toolCalls.map((call) => ({
      name: call.toolName,
      input: call.input,
      output: step.toolResults.find((r) => r.toolCallId === call.toolCallId)?.output,
    })),
  )
}

type ToolOutput = {
  ok?: boolean
  error?: string
  task?: { number: number; title: string; dueText?: string | null; reminders?: string[]; repeats?: string } | string
  deleted?: Array<{ title: string }>
  remindAt?: string
  undone?: string
}

/** Plain confirmation of saved changes, for when the model fails before replying. */
export function summarize(records: ToolCallRecord[]): string {
  const lines = records.flatMap(({ name, output }) => {
    const out = output as ToolOutput | undefined
    if (!out || READ_ONLY_TOOLS.has(name)) return []
    if (out.ok === false) return [`⚠️ ${out.error}`]
    const task = typeof out.task === 'object' ? out.task : undefined
    const when = task?.dueText ? ` — ${task.dueText}` : ''
    switch (name) {
      case 'createTask':
        return [`✅ Added *${task?.title}*${when}${task?.reminders?.length ? ' ⏰' : ''}${task?.repeats ? ` 🔁 ${task.repeats}` : ''}`]
      case 'updateTask':
        return [`✏️ Updated *${task?.title}*${when}`]
      case 'completeTask':
        return [`✅ Completed *${task?.title}*`]
      case 'reopenTask':
        return [`↩️ *${task?.title}* is open again`]
      case 'deleteTasks':
        return [`🗑️ Deleted ${out.deleted?.map((t) => `*${t.title}*`).join(', ')}`]
      case 'addReminder':
        return [`⏰ I'll remind you about *${out.task}* ${out.remindAt}`]
      case 'cancelReminders':
        return [`🔕 Reminders cancelled for *${out.task}*`]
      case 'undoLastAction':
        return [`↩️ ${out.undone}`]
      case 'updatePreferences':
        return ['⚙️ Settings updated']
      default:
        return []
    }
  })
  return lines.length ? lines.join('\n') : 'Done ✅'
}

/** Used when the model stopped after tool calls without writing a reply. */
function fallbackText(calls: ToolCallRecord[]): string {
  const failed = calls.find((c) => (c.output as { ok?: boolean } | undefined)?.ok === false)
  if (failed) return `Sorry, that didn't work: ${(failed.output as { error?: string }).error ?? 'unknown error'}`
  return calls.length ? 'Done ✅' : "Sorry, I didn't catch that. Could you rephrase?"
}
