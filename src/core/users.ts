import { and, count, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { messages, users, type User } from '../db/schema.js'
import type { UserAddress } from '../channels/types.js'
import { guessTimezone, type Clock } from '../tasks/time.js'

export type Preferences = {
  timezone?: string
  digestEnabled?: boolean
  /** "HH:MM" local time */
  digestTime?: string
}

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly defaultTimezone: string,
  ) {}

  /** Finds the user for an address, creating them on first contact. */
  async touch(address: UserAddress, pushName?: string): Promise<{ user: User; isNew: boolean }> {
    const now = this.clock()
    const [existing] = await this.db.select().from(users).where(eq(users.jid, address.id))
    if (existing) {
      const [user] = await this.db
        .update(users)
        .set({
          lastSeenAt: now,
          name: pushName || existing.name,
          phone: existing.phone ?? address.phone ?? null,
        })
        .where(eq(users.id, existing.id))
        .returning()
      return { user: user!, isNew: false }
    }
    const [created] = await this.db
      .insert(users)
      .values({
        jid: address.id,
        phone: address.phone ?? null,
        name: pushName ?? null,
        timezone: guessTimezone(address.phone),
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing({ target: users.jid })
      .returning()
    if (created) return { user: created, isNew: true }
    // Lost a race with a concurrent insert for the same address.
    const [user] = await this.db.select().from(users).where(eq(users.jid, address.id))
    return { user: user!, isNew: false }
  }

  async get(userId: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId))
    return user ?? null
  }

  zoneOf(user: Pick<User, 'timezone'>): string {
    return user.timezone ?? this.defaultTimezone
  }

  async zoneFor(userId: string): Promise<string> {
    const user = await this.get(userId)
    return user ? this.zoneOf(user) : this.defaultTimezone
  }

  async updatePreferences(userId: string, prefs: Preferences): Promise<User> {
    const changes: Partial<typeof users.$inferInsert> = {}
    if (prefs.timezone !== undefined) changes.timezone = prefs.timezone
    if (prefs.digestEnabled !== undefined) changes.digestEnabled = prefs.digestEnabled
    if (prefs.digestTime !== undefined) {
      changes.digestTime = `${prefs.digestTime}:00`
      if (prefs.digestEnabled === undefined) changes.digestEnabled = true
    }
    if (changes.digestEnabled && !prefs.digestTime) {
      const current = await this.get(userId)
      if (!current?.digestTime) changes.digestTime = '08:00:00'
    }
    const [user] = await this.db.update(users).set(changes).where(eq(users.id, userId)).returning()
    return user!
  }

  async markOnboarded(userId: string): Promise<void> {
    await this.db.update(users).set({ onboardedAt: this.clock() }).where(eq(users.id, userId))
  }

  /** Deletes the user and everything they own (cascade). */
  async deleteAll(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, userId))
  }

  async incomingCountSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.direction, 'in'), gte(messages.createdAt, since)))
    return row?.n ?? 0
  }
}
