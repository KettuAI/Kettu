import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStateStore } from './app-state'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overbench-app-state-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('AppStateStore', () => {
  it('reads a file written before the update after a move was recorded', async () => {
    await writeFile(
      join(dir, 'app-state.json'),
      JSON.stringify({ version: 1, lastRunVersion: '0.0.7', dismissedUpdate: '0.0.8' }),
    )
    const store = await AppStateStore.load(dir)
    expect(store.get()).toEqual({
      lastRunVersion: '0.0.7',
      dismissedUpdate: '0.0.8',
      updateAfterMove: null,
    })
    expect(await readdir(dir)).toEqual(['app-state.json'])
  })

  it('keeps the update after a move for the next launch', async () => {
    const store = await AppStateStore.load(dir)
    store.update({ updateAfterMove: '0.0.9' })
    await store.flush()
    expect((await AppStateStore.load(dir)).get()).toMatchObject({ updateAfterMove: '0.0.9' })
  })
})
