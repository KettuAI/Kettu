import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { forkBase, forkCut, forkTitle, replyBeforeTurn } from './sessions'

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

describe('fork titles', () => {
  it('adds (fork) to the first fork of a title', () => {
    expect(forkTitle('Plan', new Set(['Plan']))).toBe('Plan (fork)')
  })

  it('numbers the forks after the first', () => {
    const taken = new Set(['Plan', 'Plan (fork)'])
    expect(forkTitle('Plan', taken)).toBe('Plan (fork 1)')
    taken.add('Plan (fork 1)')
    expect(forkTitle('Plan', taken)).toBe('Plan (fork 2)')
  })

  it('takes the first number a deleted fork left free', () => {
    const taken = new Set(['Plan (fork)', 'Plan (fork 2)'])
    expect(forkTitle('Plan', taken)).toBe('Plan (fork 1)')
  })

  it('drops a fork suffix, in either language, from the title it starts from', () => {
    expect(forkBase('Plan (fork)')).toBe('Plan')
    expect(forkBase('Plan (fork 3)')).toBe('Plan')
    expect(forkBase('Plan\uFF08\u5206\u53C9\uFF09')).toBe('Plan')
    expect(forkBase('Plan\uFF08\u5206\u53C9 2\uFF09')).toBe('Plan')
    expect(forkBase('Plan (fork) notes')).toBe('Plan (fork) notes')
    expect(forkBase('Plan')).toBe('Plan')
  })

  it('does not stack the suffix when a fork is forked', () => {
    const taken = new Set(['Plan', 'Plan (fork)'])
    expect(forkTitle(forkBase('Plan (fork)'), taken)).toBe('Plan (fork 1)')
  })
})
