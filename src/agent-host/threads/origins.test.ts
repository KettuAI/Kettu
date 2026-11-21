import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { originOf, restoredOrigins, type MessageOrigin, type StoredOrigin } from './origins'

const say = (id: string, text: string): Extract<ThreadEntry, { kind: 'user' }> => ({
  kind: 'user',
  id,
  content: [{ type: 'text', text }],
})
const reply = (id: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown: 'Done.',
  attachments: [],
  streaming: false,
})

const fromReview = { from: { sessionId: 'review', title: 'Review' } }
const reminder = 'Your step is not reported yet.'

describe('origins of a rebuilt thread', () => {
  it("puts back each kept origin on the message it was kept for, in order, past the user's own", () => {
    const kept: StoredOrigin[] = [
      { text: reminder, origin: { kettu: true } },
      { text: 'Check the result', origin: { device: { id: 'phone', name: 'Phone' } } },
      { text: reminder, origin: { kettu: true } },
      { text: 'Restart browser and check', origin: fromReview },
    ]
    const rebuilt = [
      say('u0', 'Fix the login test'),
      reply('a0'),
      say('u1', reminder),
      say('u2', 'Typed in a terminal'),
      say('u3', 'Check the result'),
      say('u4', reminder),
      say('u5', 'Restart browser and check'),
    ]
    expect(restoredOrigins(rebuilt, kept)).toEqual(
      new Map<string, MessageOrigin>([
        ['u1', { kettu: true }],
        ['u3', { device: { id: 'phone', name: 'Phone' } }],
        ['u4', { kettu: true }],
        ['u5', fromReview],
      ]),
    )
  })

  it("matches a message the agent got with Kettu's guide or carried context ahead of it", () => {
    const kept: StoredOrigin[] = [{ text: 'Restart browser and check', origin: fromReview }]
    const rebuilt = [
      say('u0', '<kettu-guide>\nUse the tools.\n</kettu-guide>\n\nRestart browser and check'),
    ]
    expect(restoredOrigins(rebuilt, kept).get('u0')).toEqual(fromReview)
  })

  it("leaves a message that matches no kept origin as the user's, and never reuses one", () => {
    const kept: StoredOrigin[] = [{ text: reminder, origin: { kettu: true } }]
    const rebuilt = [
      say('u0', `Please read: ${reminder}`),
      say('u1', reminder),
      say('u2', reminder),
      say('u3', ''),
    ]
    expect(restoredOrigins(rebuilt, kept)).toEqual(
      new Map<string, MessageOrigin>([['u1', { kettu: true }]]),
    )
  })

  it('does not look back past an origin already used', () => {
    const kept: StoredOrigin[] = [
      { text: 'first', origin: { kettu: true } },
      { text: 'second', origin: fromReview },
    ]
    const rebuilt = [say('u0', 'second'), say('u1', 'first')]
    expect(restoredOrigins(rebuilt, kept)).toEqual(
      new Map<string, MessageOrigin>([['u0', fromReview]]),
    )
  })

  it("reads an entry's origin, and none for the user's own message", () => {
    expect(originOf(say('u0', 'mine'))).toBeNull()
    expect(originOf({ ...say('u1', 'x'), kettu: true, steered: true })).toEqual({ kettu: true })
    expect(originOf(reply('a0'))).toBeNull()
  })
})
