import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _thumbnailsCacheForTests } from './thumbnails'

describe('thumbnail LRU cache budgets', () => {
  beforeEach(() => {
    _thumbnailsCacheForTests.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _thumbnailsCacheForTests.clear()
  })

  it('enforces the smaller entry count and byte budget on web clients', () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })

    for (let i = 0; i < 60; i++) {
      _thumbnailsCacheForTests.settleForTest(`a${i}:1`, {
        state: 'ready',
        src: 'data:image/png;base64,' + 'A'.repeat(100),
        pages: null,
      })
    }
    expect(_thumbnailsCacheForTests.size()).toBeLessThanOrEqual(40)

    // Large thumbnails evict older entries to stay under the 8 MiB web budget.
    const bigSrc = 'data:image/png;base64,' + 'B'.repeat(1_200_000) // ~2.4 MB UTF-16
    for (let i = 0; i < 6; i++) {
      _thumbnailsCacheForTests.settleForTest(`big${i}:1`, {
        state: 'ready',
        src: bigSrc,
        pages: null,
      })
    }
    expect(_thumbnailsCacheForTests.bytes()).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(_thumbnailsCacheForTests.size()).toBeLessThanOrEqual(3)
  })
})
