import { z } from 'zod'
import { DateTime } from 'luxon'

/** Empty strings in .env mean "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined))

const modelRef = z
  .string()
  .regex(/^(google|groq):.+$/, 'must look like "google:<model-id>" or "groq:<model-id>"')

const timezone = z.string().refine((tz) => DateTime.local().setZone(tz).isValid, {
  message: 'must be a valid IANA timezone, e.g. "Asia/Karachi"',
})

const envSchema = z.object({
  WA_LINK_METHOD: z.enum(['qr', 'pairing']).default('qr'),
  WA_PAIRING_PHONE: optionalString,
  WA_ALLOWLIST: optionalString.transform((v) =>
    v ? v.split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean) : [],
  ),

  GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  GROQ_API_KEY: optionalString,
  LLM_PRIMARY: modelRef.default('groq:openai/gpt-oss-120b'),
  /** Comma-separated, tried in order when the primary fails (rate limit, outage). */
  LLM_FALLBACK: optionalString
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(modelRef)),
  TRANSCRIBE_MODEL: z.string().default('whisper-large-v3-turbo'),

  DATABASE_URL: optionalString,

  DEFAULT_TIMEZONE: timezone.default('Asia/Karachi'),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(20),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(10),
  HTTP_PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  ADMIN_PASSWORD: optionalString,
})

export type Env = z.output<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment variables:\n${issues.join('\n')}`)
  }
  const env = parsed.data
  if (env.WA_LINK_METHOD === 'pairing' && !env.WA_PAIRING_PHONE) {
    throw new Error('WA_PAIRING_PHONE is required when WA_LINK_METHOD=pairing')
  }
  return env
}

/** Checks the keys needed by the LLM providers that are actually configured. */
export function assertAiKeys(env: Env): void {
  const missing = new Set<string>()
  for (const ref of [env.LLM_PRIMARY, ...env.LLM_FALLBACK]) {
    if (ref.startsWith('google:') && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
      missing.add('GOOGLE_GENERATIVE_AI_API_KEY')
    }
    if (ref.startsWith('groq:') && !env.GROQ_API_KEY) missing.add('GROQ_API_KEY')
  }
  if (missing.size > 0) {
    throw new Error(`Missing API keys in .env: ${[...missing].join(', ')}`)
  }
}
