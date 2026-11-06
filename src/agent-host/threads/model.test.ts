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

  it('stores a setup nobody finished as not done in time', () => {
    const waiting: ThreadEntry = {
      kind: 'computer_setup',
      id: 'e:2',
      requestId: 2,
      steps: ['enable', 'accessibility'],
      done: ['enable'],
      outcome: null,
      after: null,
    }
    expect(settled(waiting)).toEqual({ ...waiting, outcome: 'timeout' })
    const finished: ThreadEntry = {
      ...waiting,
      done: ['enable', 'accessibility'],
      outcome: 'ready',
    }
    expect(settled(finished)).toBe(finished)
  })
})
