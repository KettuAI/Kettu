import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { forkCut, replyBeforeTurn } from './sessions'

const user = (id: string, steered = false): ThreadEntry => ({
  kind: 'user',
  id,
  content: [{ type: 'text', text: id }],
  ...(steered ? { steered } : {}),
})
const agent = (id: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown: id,
  attachments: [],
  streaming: false,
})

function thread(...entries: ThreadEntry[]): Pick<ThreadState, 'order' | 'byId'> {
  return {
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

describe('replyBeforeTurn', () => {
  it('finds the last reply before the turn in progress', () => {
    const state = thread(
      user('u:1'),
      agent('m:a#agent'),
      user('u:2'),
      agent('m:b#agent'),
      user('u:3'),
    )
    expect(replyBeforeTurn(state)).toBe('m:b#agent')
  })

  it('skips the messages of the turn in progress, steered ones included', () => {
    const state = thread(
      user('u:1'),
      agent('m:a#agent'),
      user('u:2'),
      agent('m:b#agent'),
      user('u:3', true),
      agent('m:c#agent'),
    )
    expect(replyBeforeTurn(state)).toBe('m:a#agent')
  })

  it('finds nothing in the first turn', () => {
    expect(replyBeforeTurn(thread(user('u:1'), agent('m:a#agent')))).toBeUndefined()
  })
})

describe('forkCut with a running turn', () => {
  it('cuts at the reply before the turn in progress', () => {
    const state = thread(user('u:1'), agent('m:a#agent'), user('u:2'), agent('m:b#agent'))
    const cut = forkCut(state, replyBeforeTurn(state)!)
    expect(cut?.entries.map((e) => e.id)).toEqual(['u:1', 'm:a#agent'])
    expect(cut?.point.messageId).toBe('a')
  })

  it('has no end for a reply of the turn in progress', () => {
    const state = thread(user('u:1'), agent('m:a#agent'), user('u:2'), agent('m:b#agent'))
    expect(forkCut(state, 'm:b#agent')).toBeNull()
  })
})
