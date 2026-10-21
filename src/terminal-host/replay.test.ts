import { describe, expect, it } from 'vitest'
import { ReplayBuffer } from './replay'

describe('ReplayBuffer', () => {
  it('keeps everything below the limit', () => {
    const replay = new ReplayBuffer(100)
    replay.append('hello ')
    replay.append('world')
    expect(replay.snapshot()).toBe('hello world')
    expect(replay.size).toBe(11)
  })

  it('drops whole chunks from the front', () => {
    const replay = new ReplayBuffer(20)
    replay.append('first line\n')
    replay.append('second\n')
    replay.append('third line\n')
    expect(replay.snapshot()).toBe('second\nthird line\n')
    expect(replay.size).toBe(18)
  })

  it('skips a line that trimming cut in half', () => {
    const replay = new ReplayBuffer(20)
    replay.append('first li')
    replay.append('ne\nsecond\n')
    replay.append('third\n')
    expect(replay.snapshot()).toBe('second\nthird\n')
  })

  it('keeps the tail of a chunk larger than the limit', () => {
    const replay = new ReplayBuffer(10)
    replay.append('0123456789abcdef')
    expect(replay.size).toBe(10)
    expect(replay.snapshot()).toBe('6789abcdef')
    replay.append('\nnext\n')
    expect(replay.snapshot()).toBe('next\n')
  })

  it('counts UTF-8 bytes and never splits a character', () => {
    const replay = new ReplayBuffer(7)
    replay.append('aé中文') // 1 + 2 + 3 + 3 bytes
    expect(replay.snapshot()).toBe('中文')
    expect(replay.size).toBe(6)
  })

  it('stays within the limit across many small writes', () => {
    const replay = new ReplayBuffer(1000)
    for (let i = 0; i < 5000; i++) replay.append(`line ${i}\n`)
    expect(replay.size).toBeLessThanOrEqual(1000)
    expect(replay.snapshot().endsWith('line 4999\n')).toBe(true)
    expect(replay.snapshot().startsWith('line ')).toBe(true)
  })
})
