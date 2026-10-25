import { createApp } from './app.js'
import { BaileysChannel } from './channels/baileys/channel.js'
import { assertAiKeys, loadEnv } from './config/env.js'
import { openDatabase } from './db/client.js'
import { createHttpApp, listen } from './http/server.js'
import { createLogger } from './lib/logger.js'

const env = loadEnv()
assertAiKeys(env)
const logger = createLogger(env.LOG_LEVEL)

const database = await openDatabase(env.DATABASE_URL)
logger.info(
  database.kind === 'pglite'
    ? 'Using the local embedded database (.data/pglite). Set DATABASE_URL to use Supabase.'
    : 'Connected to Postgres',
)

const channel = new BaileysChannel({
  db: database.db,
  logger,
  linkMethod: env.WA_LINK_METHOD,
  pairingPhone: env.WA_PAIRING_PHONE,
})
const app = createApp({ env, db: database.db, channel, logger })

const server = await listen(
  createHttpApp({
    db: database.db,
    channel,
    adminPassword: env.ADMIN_PASSWORD,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    logger,
  }),
  env.HTTP_PORT,
)
logger.info(`HTTP server on http://localhost:${env.HTTP_PORT} (/health, /link, /admin)`)

await app.start()

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'Shutting down…')
  await app.stop()
  server.close()
  await database.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'))
