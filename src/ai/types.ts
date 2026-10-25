import type { User } from '../db/schema.js'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

export type AssistantInput = {
  user: User
  text: string
  /** Earlier messages, oldest first (not including `text`). */
  history: ChatTurn[]
}

export type ToolCallRecord = { name: string; input: unknown; output: unknown }

export type AssistantOutput = {
  text: string
  toolCalls: ToolCallRecord[]
  model?: string
}

/** Turns a user message into actions + a reply. The LLM implementation lives in agent.ts. */
export interface Assistant {
  reply(input: AssistantInput): Promise<AssistantOutput>
}

/** All configured models failed (rate limit, outage…). */
export class AssistantUnavailableError extends Error {
  constructor(cause: unknown) {
    super('All language models failed', { cause })
    this.name = 'AssistantUnavailableError'
  }
}
