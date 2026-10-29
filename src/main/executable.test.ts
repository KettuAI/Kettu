import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isExecutableFile } from './executable'

describe('isExecutableFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kettu-exec-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('needs the execute bit on POSIX', async () => {
    const program = join(dir, 'tool')
    await writeFile(program, '#!/bin/sh\n')
    expect(await isExecutableFile(program, process.platform)).toBe(false)
    await chmod(program, 0o755)
    expect(await isExecutableFile(program, process.platform)).toBe(true)
  })

  it('accepts only program extensions on Windows', async () => {
    const exe = join(dir, 'opencode.EXE')
    const text = join(dir, 'notes.txt')
    await writeFile(exe, '')
    await writeFile(text, '')
    expect(await isExecutableFile(exe, 'win32')).toBe(true)
    expect(await isExecutableFile(text, 'win32')).toBe(false)
  })

  it('rejects folders and missing files', async () => {
    expect(await isExecutableFile(dir, process.platform)).toBe(false)
    expect(await isExecutableFile(join(dir, 'missing'), process.platform)).toBe(false)
  })
})
