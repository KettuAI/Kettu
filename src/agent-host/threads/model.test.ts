import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { settled } from './model'

describe('settled', () => {
  it('stores a first use of an app nobody answered as unanswered', () => {
    const waiting: ThreadEntry = {
      kind: 'computer_app',
      id: 'e:1',
      requestId: 1,
      appId: 'com.apple.textedit',
      appName: 'TextEdit',
      decision: null,
      after: null,
    }
    expect(settled(waiting)).toEqual({ ...waiting, decision: 'timeout' })
    const answered: ThreadEntry = { ...waiting, decision: 'always' }
    expect(settled(answered)).toBe(answered)
  })
})
