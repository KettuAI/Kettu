import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CapabilityContext } from './dispatcher'
import {
  filesCapability,
  listProject,
  projectPathProblem,
  READ_BYTES,
  readProjectFile,
} from './files-capability'

let base: string
let project: string

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'kettu-files-cap-'))
  project = path.join(base, 'project')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  mkdirSync(path.join(project, '.git'))
  writeFileSync(path.join(project, 'README.md'), '# Hello\n')
  writeFileSync(path.join(project, 'src', 'main.ts'), 'export {}\n')
  writeFileSync(path.join(project, 'logo.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
  writeFileSync(path.join(project, '.git', 'config'), '[core]\n')
  writeFileSync(path.join(base, 'secret.txt'), 'outside\n')
  mkdirSync(path.join(base, 'elsewhere'))
  symlinkSync(path.join(base, 'secret.txt'), path.join(project, 'leak.txt'))
  symlinkSync(path.join(base, 'elsewhere'), path.join(project, 'away'))
  symlinkSync(path.join(project, 'src', 'main.ts'), path.join(project, 'entry.ts'))
  symlinkSync(path.join(project, '.git', 'config'), path.join(project, 'config'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { code: string }).code
  }
  return 'ok'
}

describe('paths a page gives the files capability', () => {
  it('are taken only from the project folder down, outside .git', () => {
    for (const ok of ['', 'README.md', 'src/main.ts', '.github/workflows/ci.yml', 'a b/c.txt']) {
      expect(projectPathProblem(ok)).toBeNull()
    }
    for (const bad of [
      '/etc/passwd',
      '../secret.txt',
      'src/../../secret.txt',
      './README.md',
      'src//main.ts',
      'src/',
      '.git/config',
      'sub/.GIT/HEAD',
      'C:/Windows',
      'src\\main.ts',
      'name.',
      'name ',
      'line\nbreak',
      'x'.repeat(5000),
    ]) {
      expect(projectPathProblem(bad), bad).not.toBeNull()
    }
  })
})

describe("reading the project's files", () => {
  it('reads a file, and one a link inside the project leads to', async () => {
    expect((await readProjectFile(project, 'README.md')).toString()).toBe('# Hello\n')
    expect((await readProjectFile(project, 'entry.ts')).toString()).toBe('export {}\n')
  })

  it('refuses what a link leads to outside the project or into .git', async () => {
    expect(await code(() => readProjectFile(project, 'leak.txt'))).toBe('not_found')
    expect(await code(() => readProjectFile(project, 'config'))).toBe('not_found')
    expect(await code(() => readProjectFile(project, 'away'))).toBe('not_found')
    expect(await code(() => readProjectFile(project, '.git/config'))).toBe('invalid')
    expect(await code(() => readProjectFile(project, '../secret.txt'))).toBe('invalid')
    expect(await code(() => readProjectFile(project, 'missing.txt'))).toBe('not_found')
    expect(await code(() => readProjectFile(project, 'src'))).toBe('invalid')
    expect(await code(() => readProjectFile(project, ''))).toBe('invalid')
  })

  it('refuses a file over the limit', async () => {
    const big = path.join(project, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, READ_BYTES + 1)
    expect(await code(() => readProjectFile(project, 'big.bin'))).toBe('too_large')
  })

  it('lists folders first, leaving out .git and links that lead out', async () => {
    expect(await listProject(project, '')).toEqual([
      { name: 'src', path: 'src', type: 'folder', size: 0 },
      { name: 'entry.ts', path: 'entry.ts', type: 'file', size: 10 },
      { name: 'logo.bin', path: 'logo.bin', type: 'file', size: 4 },
      { name: 'README.md', path: 'README.md', type: 'file', size: 8 },
    ])
    expect(await listProject(project, 'src')).toEqual([
      { name: 'main.ts', path: 'src/main.ts', type: 'file', size: 10 },
    ])
    expect(await code(() => listProject(project, 'away'))).toBe('not_found')
    expect(await code(() => listProject(project, '.git'))).toBe('invalid')
  })
})

describe('the files capability', () => {
  const ctx = (projectFolder: string | null): CapabilityContext => ({
    artifactId: 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3',
    project: projectFolder,
    version: 1,
    declared: ['files'],
    client: 'desktop',
    signal: new AbortController().signal,
  })

  it('reads text, or bytes as base64, and says when a file is not text', async () => {
    const files = filesCapability()
    expect(await files.call(ctx(project), 'read', { path: './README.md' })).toEqual({
      path: 'README.md',
      size: 8,
      type: expect.any(String),
      text: '# Hello\n',
    })
    expect(await files.call(ctx(project), 'read', { path: 'logo.bin', as: 'base64' })).toEqual({
      path: 'logo.bin',
      size: 4,
      type: expect.any(String),
      base64: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64'),
    })
    expect(await code(() => files.call(ctx(project), 'read', { path: 'logo.bin' }))).toBe('invalid')
    expect(await code(() => files.call(ctx(project), 'read', { path: 7 }))).toBe('invalid')
  })

  it('is not there for an artifact without a project', async () => {
    const files = filesCapability()
    expect(await files.available!(ctx(null))).toBe(false)
    expect(await files.available!(ctx(project))).toBe(true)
    expect(await code(() => files.call(ctx(null), 'list', {}))).toBe('unsupported')
  })
})
