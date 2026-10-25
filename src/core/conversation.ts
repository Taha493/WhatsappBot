import { and, desc, eq, ne, or, isNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { messages } from '../db/schema.js'
import type { ChatTurn, ToolCallRecord } from '../ai/types.js'
import type { Clock } from '../tasks/time.js'

/** Message log: dedupe for incoming messages and short-term memory for the assistant. */
export class ConversationLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Stores an incoming message. Returns false if it was already processed (duplicate delivery). */
  async recordIncoming(userId: string, waMessageId: string, type: string, content: string | null): Promise<boolean> {
    const rows = await this.db
      .insert(messages)
      .values({ userId, waMessageId, direction: 'in', type, content, createdAt: this.clock() })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning({ id: messages.id })
    return rows.length > 0
  }

  async setContent(waMessageId: string, content: string): Promise<void> {
    await this.db.update(messages).set({ content }).where(eq(messages.waMessageId, waMessageId))
  }

  async recordOutgoing(
    userId: string,
    entry: { waMessageId?: string | null; type?: string; content: string; toolCalls?: ToolCallRecord[]; error?: string },
  ): Promise<void> {
    await this.db.insert(messages).values({
      userId,
      waMessageId: entry.waMessageId ?? null,
      direction: 'out',
      type: entry.type ?? 'text',
      content: entry.content,
      toolCalls: entry.toolCalls?.length ? entry.toolCalls : null,
      error: entry.error ?? null,
      createdAt: this.clock(),
    })
  }

  /**
   * Recent turns, oldest first, excluding `currentWaMessageId`. Consecutive turns from the
   * same side are merged and the list starts with a user turn (some providers require it).
   */
  async history(userId: string, limit: number, currentWaMessageId?: string): Promise<ChatTurn[]> {
    const rows = await this.db
      .select({ direction: messages.direction, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.userId, userId),
          currentWaMessageId
            ? or(isNull(messages.waMessageId), ne(messages.waMessageId, currentWaMessageId))
            : undefined,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(limit)

    const turns: ChatTurn[] = []
    for (const row of rows.reverse()) {
      if (!row.content) continue
      const role = row.direction === 'in' ? 'user' : 'assistant'
      const last = turns.at(-1)
      if (last?.role === role) last.content += `\n${row.content}`
      else turns.push({ role, content: row.content })
    }
    while (turns[0]?.role === 'assistant') turns.shift()
    return turns
  }
}
