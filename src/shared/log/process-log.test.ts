import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  flushLog,
  openProcessLog,
  setLogLevel,
  setVerboseRecords,
  sideLog,
  VERBOSE_PREFIX,
} from './process-log'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-log-'))
  openProcessLog({ dir, name: 'test', level: 'debug' })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const verboseFiles = async (): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.startsWith(VERBOSE_PREFIX))

describe('detailed records', () => {
  it('are not written at the debug level alone, as in a debug run', async () => {
    setLogLevel('debug')
    sideLog('verbose', 'agent-one').write('traffic', 'session/prompt', { text: 'a prompt' })
    await flushLog()
    expect(await verboseFiles()).toEqual([])
  })

  it('are written only while they are on', async () => {
    setVerboseRecords(true)
    sideLog('verbose', 'agent-one').write('traffic', 'session/prompt', { text: 'a prompt' })
    await flushLog()
    expect(await verboseFiles()).toHaveLength(1)
    setVerboseRecords(false)
  })
})
