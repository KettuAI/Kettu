// A model provider refusing a request because the account has no credit left. ACP has no error
// for it: the adapters pass the provider's reply on as an internal error, so its words decide.

import type { HostError } from './errors'

/** Each provider's words for it, compared without case; one added needs a real error from it. */
const PHRASES = [
  'insufficient balance', // DeepSeek
  'credit balance is too low', // Anthropic
  'insufficient_quota', // OpenAI
  'exceeded your current quota', // OpenAI
]

const PAYMENT_REQUIRED = 402

export function isOutOfCredit(error: Pick<HostError, 'code' | 'message' | 'data'>): boolean {
  if (error.code !== 'agent_error') return false
  const data = (error.data as { data?: unknown } | undefined)?.data
  if (statusOf(data) === PAYMENT_REQUIRED) return true
  const text = `${error.message}\n${textOf(data)}`.toLowerCase()
  return PHRASES.some((phrase) => text.includes(phrase))
}

function statusOf(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return undefined
  const { status, statusCode } = data as { status?: unknown; statusCode?: unknown }
  return status ?? statusCode
}

function textOf(data: unknown): string {
  if (data === undefined) return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data) ?? ''
  } catch {
    return ''
  }
}
