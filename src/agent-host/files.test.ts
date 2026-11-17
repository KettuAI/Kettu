import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyName, FilesService } from './files'
import { createExec, type Exec } from './git/exec'
import { tempFolder } from './testing/temp'

const noGit: Exec = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  failure: 'not-found',
  message: 'git is not installed',
})

async function setup(exec: Exec = noGit) {
  const base = await realpath(await tempFolder('kettu-files-'))
  const root = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const trashed: string[][] = []
  const files = new FilesService({
    exec,
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    media: async () => null,
    describeMedia: async () => null,
    trash: async (paths) => {
      trashed.push(paths)
    },
  })
  return { root, outside, files, trashed }
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

const rejectsWith = (run: Promise<unknown>, code: string) =>
  expect(run).rejects.toMatchObject({ code })

describe('copyName', () => {
  it('puts the copy before the extension, and not in a dot file or a folder', () => {
    expect(copyName('a.ts', 1, false)).toBe('a copy.ts')
    expect(copyName('a.test.ts', 2, false)).toBe('a.test copy 2.ts')
    expect(copyName('.env', 1, false)).toBe('.env copy')
    expect(copyName('v1.2', 1, true)).toBe('v1.2 copy')
  })
})

describe('FilesService file operations', () => {
  it('creates a file or folder with the folders above it, and never replaces one', async () => {
    const { root, files } = await setup()
    await files.create(root, 'a/b/c.ts', 'file')
    expect(await readFile(path.join(root, 'a/b/c.ts'), 'utf8')).toBe('')
    await files.create(root, 'a/d', 'folder')
    expect((await lstat(path.join(root, 'a/d'))).isDirectory()).toBe(true)
    await writeFile(path.join(root, 'a/b/c.ts'), 'kept')
    await rejectsWith(files.create(root, 'a/b/c.ts', 'file'), 'conflict')
    await rejectsWith(files.create(root, 'a/d', 'folder'), 'conflict')
    expect(await readFile(path.join(root, 'a/b/c.ts'), 'utf8')).toBe('kept')
  })

  it('refuses paths out of the project, the project itself and .git', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, '.git'))
    await symlink(outside, path.join(root, 'away'))
    for (const bad of ['../x', '/x', 'a/../../x', '', '.', '.git/config', 'a/.git']) {
      await rejectsWith(files.create(root, bad, 'file'), 'invalid_params')
    }
    await rejectsWith(files.create(root, 'away/x', 'file'), 'invalid_params')
    await rejectsWith(files.create(root, 'away/deeper/x', 'folder'), 'invalid_params')
    expect(await exists(path.join(outside, 'x'))).toBe(false)
    expect(await exists(path.join(outside, 'deeper'))).toBe(false)
  })

  it('renames and moves without replacing what is there', async () => {
    const { root, files } = await setup()
    await writeFile(path.join(root, 'a.ts'), 'a')
    await writeFile(path.join(root, 'b.ts'), 'b')
    await rejectsWith(files.rename(root, 'a.ts', 'b.ts'), 'conflict')
    expect(await readFile(path.join(root, 'b.ts'), 'utf8')).toBe('b')
    await files.rename(root, 'a.ts', 'src/lib/a2.ts')
    expect(await readFile(path.join(root, 'src/lib/a2.ts'), 'utf8')).toBe('a')
    expect(await exists(path.join(root, 'a.ts'))).toBe(false)
    await files.rename(root, 'b.ts', 'B.ts')
    expect(await readFile(path.join(root, 'B.ts'), 'utf8')).toBe('b')
    await rejectsWith(files.rename(root, 'missing.ts', 'm.ts'), 'not_found')
  })

  it('never moves a folder into itself, out of the project or into .git', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, 'src/inner'), { recursive: true })
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, 'f.ts'), 'f')
    await symlink(outside, path.join(root, 'away'))
    await rejectsWith(files.rename(root, 'src', 'src/inner/src'), 'invalid_params')
    await rejectsWith(files.rename(root, 'f.ts', 'away/f.ts'), 'invalid_params')
    await rejectsWith(files.rename(root, 'f.ts', '../f.ts'), 'invalid_params')
    await rejectsWith(files.rename(root, 'f.ts', '.git/f.ts'), 'invalid_params')
    await rejectsWith(files.rename(root, '.git', 'git'), 'invalid_params')
    expect(await exists(path.join(outside, 'f.ts'))).toBe(false)
    expect(await exists(path.join(root, 'f.ts'))).toBe(true)
  })

  it('moves a link itself, never what it points to', async () => {
    const { root, outside, files } = await setup()
    await writeFile(path.join(outside, 'secret'), 's')
    await symlink(path.join(outside, 'secret'), path.join(root, 'link'))
    await files.rename(root, 'link', 'moved')
    expect(await readlink(path.join(root, 'moved'))).toBe(path.join(outside, 'secret'))
    expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('s')
  })

  it('copies under a free name, links as links, and never a folder into itself', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, 'dir'))
    await writeFile(path.join(root, 'dir/a.ts'), 'a')
    await symlink(outside, path.join(root, 'dir/away'))
    expect(await files.copy(root, ['dir/a.ts'], 'dir')).toEqual(['dir/a copy.ts'])
    expect(await files.copy(root, ['dir/a.ts'], 'dir')).toEqual(['dir/a copy 2.ts'])
    expect(await files.copy(root, ['dir/a.ts', 'dir'], '')).toEqual(['a.ts', 'dir copy'])
    expect(await readFile(path.join(root, 'dir copy/a.ts'), 'utf8')).toBe('a')
    expect((await lstat(path.join(root, 'dir copy/away'))).isSymbolicLink()).toBe(true)
    await rejectsWith(files.copy(root, ['dir'], 'dir'), 'invalid_params')
    await rejectsWith(files.copy(root, ['dir/a.ts'], 'dir/away'), 'invalid_params')
    await rejectsWith(files.copy(root, ['dir/a.ts'], '..'), 'invalid_params')
  })

  it('trashes absolute paths, deletes for good only when asked, and skips what is gone', async () => {
    const { root, outside, files, trashed } = await setup()
    await mkdir(path.join(root, 'dir'))
    await writeFile(path.join(root, 'dir/a.ts'), 'a')
    await writeFile(path.join(outside, 'kept'), 'k')
    await symlink(path.join(outside, 'kept'), path.join(root, 'link'))
    await files.delete(root, ['dir/a.ts', 'gone.ts', 'nowhere/gone.ts'], false)
    expect(trashed).toEqual([[path.join(root, 'dir', 'a.ts')]])
    expect(await exists(path.join(root, 'dir/a.ts'))).toBe(true)
    await files.delete(root, ['dir', 'link'], true)
    expect(await exists(path.join(root, 'dir'))).toBe(false)
    expect(await exists(path.join(root, 'link'))).toBe(false)
    expect(await readFile(path.join(outside, 'kept'), 'utf8')).toBe('k')
    await mkdir(path.join(root, '.git'))
    await rejectsWith(files.delete(root, ['.git'], true), 'invalid_params')
    await rejectsWith(files.delete(root, ['..'], true), 'invalid_params')
    await rejectsWith(files.delete(root, ['link/../..'], true), 'invalid_params')
    expect(await exists(path.join(root, '.git'))).toBe(true)
  })
})

describe('FilesService empty folders', () => {
  it('lists the empty folders of a folder outside git', async () => {
    const { root, files } = await setup()
    await mkdir(path.join(root, 'a/empty'), { recursive: true })
    await mkdir(path.join(root, 'b'))
    await writeFile(path.join(root, 'b/file.ts'), '')
    expect(await files.list(root)).toEqual({
      paths: ['b/file.ts'],
      folders: ['a/empty'],
      truncated: false,
    })
  })

  it('lists empty untracked folders of a repository, not ones holding ignored files', async () => {
    const exec = createExec(() => process.env).exec
    const { root, files } = await setup(exec)
    const git = (...args: string[]) => exec('git', args, { cwd: root, timeoutMs: 10_000 })
    expect((await git('init', '-q')).code).toBe(0)
    await writeFile(path.join(root, '.gitignore'), '*.log\ntmp/\n')
    await mkdir(path.join(root, 'src/new'), { recursive: true })
    await mkdir(path.join(root, 'src/tmp'), { recursive: true })
    await writeFile(path.join(root, 'src/main.ts'), '')
    await mkdir(path.join(root, 'logs'))
    await writeFile(path.join(root, 'logs/a.log'), '')
    await mkdir(path.join(root, 'outer/inner'), { recursive: true })
    expect(await files.list(root)).toEqual({
      paths: ['.gitignore', 'src/main.ts'],
      folders: ['outer/inner', 'src/new'],
      truncated: false,
    })
  })

  it('lists a folder emptied of its tracked files', async () => {
    const exec = createExec(() => process.env).exec
    const { root, files } = await setup(exec)
    const git = (...args: string[]) => exec('git', args, { cwd: root, timeoutMs: 10_000 })
    await git('init', '-q')
    await mkdir(path.join(root, 'docs/deep'), { recursive: true })
    await writeFile(path.join(root, 'docs/deep/a.md'), '')
    await writeFile(path.join(root, 'kept.md'), '')
    await git('add', '-A')
    await rm(path.join(root, 'docs/deep/a.md'))
    expect(await files.list(root)).toEqual({
      paths: ['kept.md'],
      folders: ['docs/deep'],
      truncated: false,
    })
  })
})
