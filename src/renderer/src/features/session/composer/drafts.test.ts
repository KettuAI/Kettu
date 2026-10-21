import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, flushDraft, readDraft, writeDraft } from './drafts'

class MemoryStorage {
  items = new Map<string, string>()
  failWrites = false
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('drafts', () => {
  it('writes 300 ms after the last keystroke', () => {
    writeDraft('s1', 'h')
    writeDraft('s1', 'he')
    vi.advanceTimersByTime(299)
    expect(storage.getItem('draft:s1')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(storage.getItem('draft:s1')).toBe('he')
  })

  it('reads the unsaved text before it is written', () => {
    writeDraft('s2', 'pending')
    expect(readDraft('s2')).toBe('pending')
  })

  it('removes the draft when the text is emptied or the prompt is sent', () => {
    storage.setItem('draft:s3', 'old')
    writeDraft('s3', '')
    flushDraft('s3')
    expect(storage.getItem('draft:s3')).toBeNull()
    storage.setItem('draft:s4', 'old')
    clearDraft('s4')
    expect(readDraft('s4')).toBe('')
  })

  it('keeps a draft in memory when the write fails', () => {
    storage.failWrites = true
    writeDraft('s5', 'kept')
    flushDraft('s5')
    expect(storage.getItem('draft:s5')).toBeNull()
    expect(readDraft('s5')).toBe('kept')
    expect(console.warn).toHaveBeenCalled()
  })
})
