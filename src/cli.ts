import { createApp } from './app.js'
import { CliChannel } from './channels/cli/channel.js'
import { assertAiKeys, loadEnv } from './config/env.js'
import { openDatabase } from './db/client.js'
import { createLogger } from './lib/logger.js'

/**
 * Chat with the bot in your terminal, using the same database, AI and scheduler as the
 * WhatsApp bot (reminders show up here too). No phone needed.
 */
const env = loadEnv()
assertAiKeys(env)
const logger = createLogger(process.env.CLI_LOG_LEVEL ?? 'warn')
const database = await openDatabase(env.DATABASE_URL)

const channel = new CliChannel(process.env.CLI_PHONE ?? '923001234567')
const app = createApp({
  env,
  db: database.db,
  channel,
  logger,
  outbound: { minGapMs: 0, jitterMs: 0, typing: false },
})

console.log('\n💬 Chatting with Remi in the terminal. Ctrl+C to quit.')
console.log('   Tip: start a line with ">" to reply to the last bot message, e.g. "> done".\n')
await app.start()

process.on('SIGINT', async () => {
  await app.stop()
  await database.close()
  process.exit(0)
})
