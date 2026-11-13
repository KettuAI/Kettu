import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonFileWriter } from './json-file'
import type { Logger } from './log'

let dir: string
let errors: string[]

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (message) => errors.push(message),
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-json-file-'))
  errors = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

describe('JsonFileWriter', () => {
  it('keeps a write that failed and makes it once the file can be written again', async () => {
    const file = join(dir, 'settings.json')
    const writer = new JsonFileWriter(file, log, 0, 20)
    // A folder where the temporary file goes makes every write fail, as a full disk would.
    await mkdir(`${file}.tmp`)
    writer.schedule({ value: 1 })
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    await rm(`${file}.tmp`, { recursive: true })
    await vi.waitFor(async () => expect(await read(file)).toEqual({ value: 1 }), {
      timeout: 5_000,
      interval: 20,
    })
  })

  it('writes the newer value when one came while a failed write waited', async () => {
    const file = join(dir, 'settings.json')
    const writer = new JsonFileWriter(file, log, 0, 20)
    await mkdir(`${file}.tmp`)
    writer.schedule({ value: 1 })
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    writer.schedule({ value: 2 })
    await rm(`${file}.tmp`, { recursive: true })
    await writer.flush()
    expect(await read(file)).toEqual({ value: 2 })
  })
})
