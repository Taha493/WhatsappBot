/**
 * LLM evaluation: sends each phrase in cases.yaml to the real model and checks which tools
 * it calls and with which arguments. Uses an in-memory database and a fixed clock.
 *
 *   pnpm eval                 # all cases
 *   pnpm eval -- reschedule   # only cases whose name contains "reschedule"
 *
 * Free tiers have rate limits, so cases run one by one with a pause (EVAL_DELAY_MS).
 */
import { readFile } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { parse } from 'yaml'
import { LlmAssistant } from '../src/ai/agent.js'
import { modelChain } from '../src/ai/providers.js'
import type { ToolCallRecord } from '../src/ai/types.js'
import { assertAiKeys, loadEnv } from '../src/config/env.js'
import { UserService } from '../src/core/users.js'
import { openDatabase } from '../src/db/client.js'
import { createLogger } from '../src/lib/logger.js'
import { ReminderService } from '../src/tasks/reminders.js'
import { TaskService } from '../src/tasks/service.js'
import { parseLocalDue } from '../src/tasks/time.js'

type Case = {
  name: string
  say: string
  seed?: boolean
  expect?: Array<{ tool: string; args?: Record<string, unknown> }>
  forbid?: string[]
  asks?: boolean
}

const NOW = new Date('2026-10-26T04:00:00Z') // Monday 09:00 Asia/Karachi
const ZONE = 'Asia/Karachi'
const MUTATING = ['createTask', 'updateTask', 'completeTask', 'deleteTasks', 'addReminder', 'cancelReminders', 'undoLastAction']
// Groq's free tier allows ~8k tokens/minute per model and a turn uses ~2.5k, so pace the cases.
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 12000)

const env = loadEnv()
assertAiKeys(env)
const filter = process.argv.slice(2).find((a) => a !== '--')
const cases = (parse(await readFile(new URL('./cases.yaml', import.meta.url), 'utf8')) as Case[]).filter(
  (c) => !filter || c.name.includes(filter),
)

const { db, close } = await openDatabase('memory://')
const clock = () => new Date(NOW)
const users = new UserService(db, clock, ZONE)
const tasks = new TaskService(db, new ReminderService(db, clock), clock)
const assistant = new LlmAssistant({ models: modelChain(env), tasks, users, clock, logger: createLogger('silent') })

/** Partial, forgiving deep match (see the rules at the top of cases.yaml). */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected === '*') return actual !== undefined && actual !== null && actual !== '' && !(Array.isArray(actual) && actual.length === 0)
  if (typeof expected === 'string') return typeof actual === 'string' && actual.toLowerCase().includes(expected.toLowerCase())
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e) => actual.some((a) => matches(e, a)))
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false
    return Object.entries(expected).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]))
  }
  return expected === actual
}

function check(c: Case, calls: ToolCallRecord[], reply: string): string[] {
  const problems: string[] = []
  for (const exp of c.expect ?? []) {
    const candidates = calls.filter((call) => call.name === exp.tool)
    if (!candidates.some((call) => !exp.args || matches(exp.args, call.input))) {
      problems.push(candidates.length ? `${exp.tool} args ${JSON.stringify(candidates.map((x) => x.input))}` : `missing ${exp.tool}`)
    }
  }
  for (const name of c.forbid ?? []) if (calls.some((call) => call.name === name)) problems.push(`called ${name}`)
  if (c.asks) {
    const mutated = calls.filter((call) => MUTATING.includes(call.name) && (call.output as { ok?: boolean })?.ok)
    if (mutated.length) problems.push(`changed something: ${mutated.map((m) => m.name).join(', ')}`)
    const asked = reply.includes('?') || /\b(which|do you (mean|want)|let me know|reply with|confirm)\b/i.test(reply)
    if (!asked) problems.push('did not ask a question')
  }
  return problems
}

async function seedTasks(userId: string) {
  const due = (iso: string) => parseLocalDue(iso, ZONE)!
  await tasks.create(userId, { title: 'Submit assignment', due: due('2026-10-27T10:00'), reminders: [{ minutesBefore: 0 }] })
  await tasks.create(userId, { title: 'Prepare project presentation', due: due('2026-10-29') })
  await tasks.create(userId, { title: 'Review portfolio', due: due('2026-10-30') })
  await tasks.create(userId, { title: 'Call the dentist' })
}

console.log(`\nRunning ${cases.length} eval case(s) with ${env.LLM_PRIMARY}${env.LLM_FALLBACK.length ? ` (fallback ${env.LLM_FALLBACK.join(' → ')})` : ''}\n`)
let passed = 0
const failures: string[] = []
for (const [i, c] of cases.entries()) {
  await db.execute(sql.raw('TRUNCATE users, tasks, reminders, task_events, messages RESTART IDENTITY CASCADE'))
  const { user } = await users.touch({ id: '923001234567@eval', phone: '923001234567' }, 'Taha')
  if (c.seed) await seedTasks(user.id)

  let line: string
  try {
    const out = await assistant.reply({ user, text: c.say, history: [] })
    const problems = check(c, out.toolCalls, out.text)
    if (problems.length === 0) {
      passed++
      line = `✅ ${c.name}`
    } else {
      line = `❌ ${c.name}\n     said: ${c.say}\n     ${problems.join('\n     ')}\n     reply: ${out.text.replace(/\n/g, ' ').slice(0, 160)}`
      failures.push(c.name)
    }
  } catch (err) {
    line = `💥 ${c.name}: ${(err as Error).cause ?? err}`
    failures.push(c.name)
  }
  console.log(line)
  if (i < cases.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS))
}

const score = Math.round((passed / cases.length) * 100)
console.log(`\nScore: ${passed}/${cases.length} (${score}%)`)
if (failures.length) console.log(`Failed: ${failures.join(', ')}`)
await close()
process.exit(score >= 90 ? 0 : 1)
