import { describe, expect, it } from 'vitest'
import { answerOf } from './device-browser'

describe('answerOf', () => {
  it('keeps the codes that tell the agent how a wait on the user ended', () => {
    for (const code of ['user_has_control', 'stopped'] as const) {
      expect(answerOf(undefined, { code, message: 'The user stopped.' })).toEqual({
        error: { code, message: 'The user stopped.' },
      })
    }
  })

  it('refuses a code it does not know', () => {
    expect(answerOf(undefined, { code: 'made_up', message: 'x' })).toEqual({
      error: { code: 'invalid', message: 'Main gave no answer to the call.' },
    })
  })
})
