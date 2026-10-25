import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema.js'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type DbHandle = { db: Db; kind: 'postgres' | 'pglite'; close: () => Promise<void> }

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * Opens the database and applies pending migrations.
 * - A `postgres://` URL (e.g. Supabase) uses postgres.js.
 * - No URL uses an embedded Postgres (PGlite) stored in `.data/pglite` — handy for local
 *   development before a hosted database exists.
 * - `memory://` uses an in-memory PGlite (tests, evals).
 */
export async function openDatabase(url: string | undefined): Promise<DbHandle> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { default: postgres } = await import('postgres')
    const { drizzle } = await import('drizzle-orm/postgres-js')
    const { migrate } = await import('drizzle-orm/postgres-js/migrator')
    // prepare: false keeps it compatible with Supabase's transaction pooler too.
    const client = postgres(url, { prepare: false, max: 5, onnotice: () => {} })
    const db = drizzle({ client, schema })
    await migrate(db, { migrationsFolder: MIGRATIONS })
    return { db: db as unknown as Db, kind: 'postgres', close: () => client.end() }
  }

  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  let client: InstanceType<typeof PGlite>
  if (url === 'memory://') {
    client = new PGlite()
  } else {
    mkdirSync('.data', { recursive: true })
    client = new PGlite('.data/pglite')
  }
  const db = drizzle({ client, schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return { db: db as unknown as Db, kind: 'pglite', close: () => client.close() }
}
