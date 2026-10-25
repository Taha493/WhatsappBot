import pino, { type Logger } from 'pino'

export type { Logger }

export function createLogger(level: string): Logger {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production'
  return pino({
    level,
    redact: { paths: ['*.phone', '*.jid', 'phone', 'jid'], censor: maskId },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } : {}),
  })
}

/** "923001234567@s.whatsapp.net" → "92300****567@s.whatsapp.net" */
export function maskId(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.replace(/\d{6,}/g, (digits) => digits.slice(0, 5) + '****' + digits.slice(-3))
}
