import { createGoogle } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import type { LanguageModel } from 'ai'
import type { Env } from '../config/env.js'

export type NamedModel = { ref: string; model: LanguageModel }

/** "groq:openai/gpt-oss-120b" → a language model instance. */
export function resolveModel(ref: string, env: Env): LanguageModel {
  const [provider, ...rest] = ref.split(':')
  const id = rest.join(':')
  if (provider === 'google') return createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(id)
  if (provider === 'groq') return createGroq({ apiKey: env.GROQ_API_KEY })(id)
  throw new Error(`Unknown model provider in "${ref}"`)
}

/** Primary model first, then the fallbacks in order. */
export function modelChain(env: Env): NamedModel[] {
  const refs = [env.LLM_PRIMARY, ...env.LLM_FALLBACK]
  return refs.map((ref) => ({ ref, model: resolveModel(ref, env) }))
}
