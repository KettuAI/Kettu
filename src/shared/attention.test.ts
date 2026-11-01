import { describe, expect, it } from 'vitest'
import { ATTENTION_SETTING, attentionTarget, attentionText } from './attention'

describe('attention', () => {
  it('opens the session, or Routines for a pause, and replaces the last notice of the same', () => {
    expect(
      attentionTarget({ kind: 'turn-ended', sessionId: 's1', title: 'Fix', body: 'Done' }),
    ).toEqual({ key: 's1', command: { kind: 'open-session', sessionId: 's1' } })
    expect(
      attentionTarget({ kind: 'routine-paused', agentId: 'codex', title: 'Paused', body: '' }),
    ).toEqual({ key: 'routines:codex', command: { kind: 'open-routines' } })
  })

  it('refuses a malformed message', () => {
    expect(attentionTarget({ kind: 'turn-ended', sessionId: '', title: 'x', body: 'y' })).toBeNull()
    expect(
      attentionTarget({ kind: 'nope', sessionId: 's1', title: 'x', body: 'y' } as never),
    ).toBeNull()
    expect(
      attentionTarget({ kind: 'error', sessionId: 's1', title: 5, body: 'y' } as never),
    ).toBeNull()
  })

  it('maps each kind to its switch and holds the text to what a notification shows', () => {
    expect(ATTENTION_SETTING['routine-ended']).toBe('routines')
    const text = attentionText({
      kind: 'error',
      sessionId: 's1',
      title: 't'.repeat(200),
      body: 'b'.repeat(500),
    })
    expect(text.title).toHaveLength(120)
    expect(text.title.endsWith('…')).toBe(true)
    expect(text.body).toHaveLength(400)
  })
})
