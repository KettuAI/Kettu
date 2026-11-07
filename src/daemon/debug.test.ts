import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markDebugRun, takeDebugRun, unmarkDebugRun } from './debug'

let data: string

beforeEach(async () => {
  data = await mkdtemp(path.join(os.tmpdir(), 'kettu-debug-'))
})

afterEach(async () => {
  await rm(data, { recursive: true, force: true })
})

describe('the debug marker', () => {
  it('makes only the next run a debug run', async () => {
    expect(await takeDebugRun(data)).toBe(false)
    await markDebugRun(data)
    expect(await takeDebugRun(data)).toBe(true)
    expect(await takeDebugRun(data)).toBe(false)
  })

  it('counts for no run once a failed restart removes it', async () => {
    await markDebugRun(data)
    await unmarkDebugRun(data)
    expect(await takeDebugRun(data)).toBe(false)
  })
})
