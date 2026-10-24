import { describe, expect, it } from 'vitest'

import { HostError } from './errors'
import { isOutOfCredit } from './out-of-credit'

const agentError = (message: string, data?: unknown): HostError =>
  new HostError('agent_error', message, { code: -32603, ...(data !== undefined ? { data } : {}) })

describe('isOutOfCredit', () => {
  it.each([
    ['DeepSeek', 'Internal error: Insufficient Balance (request_id: 38feb58f)'],
    ['Anthropic', 'Your credit balance is too low to access the Anthropic API.'],
    ['OpenAI by code', 'Internal error: 429 insufficient_quota'],
    ['OpenAI by message', 'You exceeded your current quota, please check your plan.'],
  ])('knows %s', (_, message) => {
    expect(isOutOfCredit(agentError(message))).toBe(true)
  })

  it('reads the phrasing from the error data too', () => {
    expect(isOutOfCredit(agentError('Internal error', { details: 'Insufficient Balance' }))).toBe(
      true,
    )
  })

  it('takes HTTP 402 in the data as out of credit', () => {
    expect(isOutOfCredit(agentError('Internal error', { status: 402 }))).toBe(true)
    expect(isOutOfCredit(agentError('Internal error', { statusCode: 402 }))).toBe(true)
  })

  it('leaves other failures alone', () => {
    expect(isOutOfCredit(agentError('Internal error: rate limit exceeded', { status: 429 }))).toBe(
      false,
    )
    expect(isOutOfCredit(agentError('The fake agent failed this turn on purpose'))).toBe(false)
    expect(isOutOfCredit(new HostError('auth_required', 'Insufficient Balance'))).toBe(false)
  })
})
