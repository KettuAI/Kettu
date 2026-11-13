import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { RotatingFile } from './rotating-file'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-log-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('writes again, what it held first, once a failed folder can be written', async () => {
  const logs = path.join(dir, 'logs')
  // A file where the folder should be makes every write fail.
  await writeFile(logs, '')
  const file = new RotatingFile({
    dir: logs,
    name: 'host',
    maxBytes: 1_000_000,
    files: 2,
    retryMs: 20,
  })
  file.write('first\n', true)
  await file.flush()
  await rm(logs)
  await new Promise((resolve) => setTimeout(resolve, 40))
  file.write('second\n', true)
  await file.flush()
  expect(await readFile(path.join(logs, 'host.log'), 'utf8')).toBe('first\nsecond\n')
  await file.close()
})
