import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { completePath, isCompletablePath, MAX_COMPLETIONS } from './path-completion'
import { tempFolder } from './testing/temp'

const platform = process.platform
const posixIt = it.skipIf(platform === 'win32')

async function tree(): Promise<string> {
  const root = await realpath(await tempFolder('kettu-complete-'))
  await mkdir(path.join(root, 'src'))
  await mkdir(path.join(root, 'scripts'))
  await mkdir(path.join(root, '.secret'))
  await writeFile(path.join(root, 'setup.sh'), '#!/bin/sh\n')
  await writeFile(path.join(root, 'Sample.txt'), 'text')
  await writeFile(path.join(root, '.env'), 'X=1')
  return root
}

describe('completePath', () => {
  it("lists the folder's entries that start as typed, folders first, then by name", async () => {
    const root = await tree()
    const done = await completePath(path.join(root, 's'), platform, root)
    expect(done.folder).toBe(root)
    expect(done.entries.map(({ name, kind }) => [name, kind])).toEqual([
      ['scripts', 'folder'],
      ['src', 'folder'],
      // Windows matches names in any case, as its paths do.
      ...(platform === 'win32' ? [['Sample.txt', 'file']] : []),
      ['setup.sh', 'file'],
    ])
    expect(done.exact).toBeNull()
  })

  it('lists every entry of a folder typed with its separator, hidden ones only after a dot', async () => {
    const root = await tree()
    const all = await completePath(root + path.sep, platform, root)
    expect(all.folder).toBe(root)
    expect(all.entries.map(({ name }) => name)).toEqual([
      'scripts',
      'src',
      'Sample.txt',
      'setup.sh',
    ])
    expect(all.exact).toEqual({ kind: 'folder', executable: false })
    const hidden = await completePath(`${root}${path.sep}.`, platform, root)
    expect(hidden.entries.map(({ name }) => name)).toEqual(['.secret', '.env'])
  })

  posixIt('says which files the host may run, and what the typed path is', async () => {
    const root = await tree()
    await chmod(path.join(root, 'setup.sh'), 0o755)
    const done = await completePath(path.join(root, 'setup.sh'), platform, root)
    expect(done.entries).toEqual([{ name: 'setup.sh', kind: 'file', executable: true }])
    expect(done.exact).toEqual({ kind: 'file', executable: true })
    const text = await completePath(path.join(root, 'Sample.txt'), platform, root)
    expect(text.exact).toEqual({ kind: 'file', executable: false })
  })

  posixIt('follows links, and leaves out one that points nowhere', async () => {
    const root = await tree()
    await symlink(path.join(root, 'src'), path.join(root, 'linked'))
    await symlink(path.join(root, 'gone'), path.join(root, 'lost'))
    const done = await completePath(path.join(root, 'l'), platform, root)
    expect(done.entries).toEqual([
      { name: 'linked', kind: 'folder', executable: false, repo: false },
    ])
  })

  it('marks the folders that hold a Git repository, a worktree included', async () => {
    const root = await tree()
    await mkdir(path.join(root, 'src', '.git'))
    await mkdir(path.join(root, 'scripts', 'nested', '.git'), { recursive: true })
    await mkdir(path.join(root, 'linked-tree'))
    await writeFile(path.join(root, 'linked-tree', '.git'), 'gitdir: /elsewhere\n')
    const done = await completePath(root + path.sep, platform, root)
    expect(
      done.entries.filter((entry) => entry.kind === 'folder').map(({ name, repo }) => [name, repo]),
    ).toEqual([
      ['linked-tree', true],
      ['scripts', false],
      ['src', true],
    ])
    expect(done.entries.find((entry) => entry.kind === 'file')).not.toHaveProperty('repo')
  })

  it('reads `~` as the home folder', async () => {
    const root = await tree()
    const done = await completePath('~/sr', platform, root)
    expect(done.folder).toBe(root)
    expect(done.entries.map(({ name }) => name)).toEqual(['src'])
    expect((await completePath('~', platform, root)).exact).toEqual({
      kind: 'folder',
      executable: false,
    })
  })

  it('lists nothing in a folder that cannot be read, and at most its limit', async () => {
    const root = await tree()
    const missing = await completePath(path.join(root, 'missing', 'x'), platform, root)
    expect(missing).toEqual({ folder: path.join(root, 'missing'), entries: [], exact: null })
    const inFile = await completePath(path.join(root, 'Sample.txt', 'x'), platform, root)
    expect(inFile.entries).toEqual([])

    const many = path.join(root, 'many')
    await mkdir(many)
    await Promise.all(
      Array.from({ length: MAX_COMPLETIONS + 5 }, (_, index) =>
        writeFile(path.join(many, `f${String(index).padStart(3, '0')}`), ''),
      ),
    )
    const listed = await completePath(many + path.sep, platform, root)
    expect(listed.entries).toHaveLength(MAX_COMPLETIONS)
    expect(listed.entries[0]?.name).toBe('f000')
  })
})

describe('isCompletablePath', () => {
  it('takes absolute paths and the home folder only', () => {
    expect(isCompletablePath('/usr/b', 'linux')).toBe(true)
    expect(isCompletablePath('~', 'darwin')).toBe(true)
    expect(isCompletablePath('~/src', 'darwin')).toBe(true)
    expect(isCompletablePath('C:\\Users', 'win32')).toBe(true)
    expect(isCompletablePath('~\\src', 'win32')).toBe(true)
    expect(isCompletablePath('~ada/src', 'linux')).toBe(false)
    expect(isCompletablePath('src', 'linux')).toBe(false)
    expect(isCompletablePath('~\\src', 'linux')).toBe(false)
  })
})
