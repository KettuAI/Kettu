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

  it("keeps the user's tab a call needs, and nothing else of it", () => {
    expect(
      answerOf(undefined, {
        code: 'needs_allow',
        message: 'Theirs',
        tab: { id: 't2', title: 'x'.repeat(300), url: 'https://mail.example/' },
      }),
    ).toEqual({
      error: { code: 'needs_allow', message: 'Theirs', tab: { id: 't2', title: 'x'.repeat(200) } },
    })
    expect(answerOf(undefined, { code: 'needs_allow', message: 'Theirs' })).toMatchObject({
      error: { code: 'invalid' },
    })
    expect(
      answerOf(undefined, { code: 'needs_allow', message: 'x', tab: { id: 'i'.repeat(65) } }),
    ).toMatchObject({ error: { code: 'invalid' } })
  })

  it('refuses a code it does not know', () => {
    expect(answerOf(undefined, { code: 'made_up', message: 'x' })).toEqual({
      error: { code: 'invalid', message: 'Main gave no answer to the call.' },
    })
  })
})
