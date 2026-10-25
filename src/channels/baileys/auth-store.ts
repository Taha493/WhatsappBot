import { eq, inArray, like, sql } from 'drizzle-orm'
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys'
import type { Db } from '../../db/client.js'
import { waAuth } from '../../db/schema.js'

const CREDS_KEY = 'creds'
/** Rows per INSERT statement when saving signal keys. */
const WRITE_BATCH = 200

/** Round-trips a value through BufferJSON so Buffers survive JSONB storage. */
const serialize = (value: unknown) => JSON.parse(JSON.stringify(value, BufferJSON.replacer))
const deserialize = <T>(value: unknown): T => JSON.parse(JSON.stringify(value), BufferJSON.reviver)

/**
 * Baileys auth state stored in Postgres (table `wa_auth`), so the bot stays linked
 * across restarts and redeploys. Same layout as Baileys' multi-file store:
 * one row for "creds" and one row per signal key ("<type>-<id>").
 */
export async function usePostgresAuthState(db: Db): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
  clear: () => Promise<void>
}> {
  const write = async (key: string, value: unknown) => {
    const row = { key, value: serialize(value), updatedAt: new Date() }
    await db
      .insert(waAuth)
      .values(row)
      .onConflictDoUpdate({ target: waAuth.key, set: { value: row.value, updatedAt: row.updatedAt } })
  }

  const [credsRow] = await db.select().from(waAuth).where(eq(waAuth.key, CREDS_KEY))
  const creds: AuthenticationCreds = credsRow
    ? deserialize<AuthenticationCreds>(credsRow.value)
    : initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {}
          if (ids.length === 0) return result
          const keys = ids.map((id) => `${type}-${id}`)
          const rows = await db.select().from(waAuth).where(inArray(waAuth.key, keys))
          for (const row of rows) {
            const id = row.key.slice(type.length + 1)
            let value = deserialize<SignalDataTypeMap[T]>(row.value)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              ) as unknown as SignalDataTypeMap[T]
            }
            result[id] = value
          }
          return result
        },
        set: async (data) => {
          // Last write wins per key (one statement can't upsert the same key twice).
          const upserts = new Map<string, unknown>()
          const deletes = new Set<string>()
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const key = `${category}-${id}`
              if (value) {
                upserts.set(key, value)
                deletes.delete(key)
              } else {
                deletes.add(key)
                upserts.delete(key)
              }
            }
          }
          // Batched: a fresh link writes ~800 pre-keys, and Baileys gives the whole
          // upload 30 s — one round trip per key to a hosted database is far too slow.
          const now = new Date()
          const rows = [...upserts].map(([key, value]) => ({ key, value: serialize(value), updatedAt: now }))
          await db.transaction(async (tx) => {
            for (let i = 0; i < rows.length; i += WRITE_BATCH) {
              await tx
                .insert(waAuth)
                .values(rows.slice(i, i + WRITE_BATCH))
                .onConflictDoUpdate({
                  target: waAuth.key,
                  set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
                })
            }
            if (deletes.size > 0) await tx.delete(waAuth).where(inArray(waAuth.key, [...deletes]))
          })
        },
      },
    },
    saveCreds: () => write(CREDS_KEY, creds),
    clear: async () => {
      await db.delete(waAuth).where(like(waAuth.key, '%'))
    },
  }
}
