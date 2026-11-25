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

describe('FilesService uploads', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

  it('puts bytes or a granted file in a folder, over what is there only when replacing', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, 'dir'))
    await files.upload(root, 'dir/a.txt', { bytes: bytes('one') }, false)
    expect(await readFile(path.join(root, 'dir/a.txt'), 'utf8')).toBe('one')
    await files.upload(root, 'empty', { bytes: new ArrayBuffer(0) }, false)
    expect(await readFile(path.join(root, 'empty'), 'utf8')).toBe('')
    await rejectsWith(files.upload(root, 'dir/a.txt', { bytes: bytes('two') }, false), 'conflict')
    expect(await readFile(path.join(root, 'dir/a.txt'), 'utf8')).toBe('one')
    await files.upload(root, 'dir/a.txt', { bytes: bytes('two') }, true)
    expect(await readFile(path.join(root, 'dir/a.txt'), 'utf8')).toBe('two')
    await writeFile(path.join(outside, 'picked.txt'), 'picked')
    await files.upload(root, 'picked.txt', { path: path.join(outside, 'picked.txt') }, false)
    expect(await readFile(path.join(root, 'picked.txt'), 'utf8')).toBe('picked')
    await rejectsWith(files.upload(root, 'dir', { bytes: bytes('x') }, true), 'invalid_params')
    expect((await lstat(path.join(root, 'dir'))).isDirectory()).toBe(true)
    await rejectsWith(
      files.upload(root, 'nowhere/a.txt', { bytes: bytes('x') }, false),
      'not_found',
    )
    expect(await exists(path.join(root, 'nowhere'))).toBe(false)
  })

  it('replaces a link itself, and never writes through one', async () => {
    const { root, outside, files } = await setup()
    await writeFile(path.join(outside, 'secret'), 's')
    await symlink(path.join(outside, 'secret'), path.join(root, 'link'))
    await symlink(path.join(outside, 'missing'), path.join(root, 'dangling'))
    await rejectsWith(files.upload(root, 'link', { bytes: bytes('x') }, false), 'conflict')
    await rejectsWith(files.upload(root, 'dangling', { bytes: bytes('x') }, false), 'conflict')
    const picked = { path: path.join(outside, 'secret') }
    await rejectsWith(files.upload(root, 'dangling', picked, false), 'conflict')
    expect(await exists(path.join(outside, 'missing'))).toBe(false)
    await files.upload(root, 'link', { bytes: bytes('x') }, true)
    expect((await lstat(path.join(root, 'link'))).isSymbolicLink()).toBe(false)
    expect(await readFile(path.join(root, 'link'), 'utf8')).toBe('x')
    expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('s')
  })

  it('refuses paths out of the project, into .git or through a link that leaves', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, '.git'))
    await symlink(outside, path.join(root, 'away'))
    for (const bad of ['../x', '/x', '', '.', '.git/x', 'a/.git', 'away/x', 'a/../../x']) {
      await rejectsWith(files.upload(root, bad, { bytes: bytes('x') }, true), 'invalid_params')
    }
    expect(await exists(path.join(outside, 'x'))).toBe(false)
    expect(await exists(path.join(root, '.git/x'))).toBe(false)
  })

  it('copies a granted folder with links as links and no .git, merging only when replacing', async () => {
    const { root, outside, files } = await setup()
    const drop = path.join(outside, 'drop')
    await mkdir(path.join(drop, 'sub'), { recursive: true })
    await mkdir(path.join(drop, '.git'))
    await writeFile(path.join(drop, 'a.txt'), 'a')
    await writeFile(path.join(drop, 'sub/b.txt'), 'b')
    await writeFile(path.join(drop, '.git/HEAD'), 'ref')
    await symlink('a.txt', path.join(drop, 'link'))
    await files.upload(root, 'drop', { path: drop }, false)
    expect(await readFile(path.join(root, 'drop/a.txt'), 'utf8')).toBe('a')
    expect(await readFile(path.join(root, 'drop/sub/b.txt'), 'utf8')).toBe('b')
    expect(await readlink(path.join(root, 'drop/link'))).toBe('a.txt')
    expect(await exists(path.join(root, 'drop/.git'))).toBe(false)
    await rejectsWith(files.upload(root, 'drop', { path: drop }, false), 'conflict')
    await writeFile(path.join(drop, 'a.txt'), 'new')
    await writeFile(path.join(root, 'drop/kept.txt'), 'kept')
    await files.upload(root, 'drop', { path: drop }, true)
    expect(await readFile(path.join(root, 'drop/a.txt'), 'utf8')).toBe('new')
    expect(await readFile(path.join(root, 'drop/kept.txt'), 'utf8')).toBe('kept')
    await writeFile(path.join(root, 'file'), 'f')
    await rejectsWith(files.upload(root, 'file', { path: drop }, true), 'invalid_params')
    expect(await readFile(path.join(root, 'file'), 'utf8')).toBe('f')
  })

  it('never merges a folder through a link, nor copies one into itself', async () => {
    const { root, outside, files } = await setup()
    const drop = path.join(outside, 'drop')
    await mkdir(path.join(drop, 'sub'), { recursive: true })
    await writeFile(path.join(drop, 'sub/b.txt'), 'b')
    const elsewhere = path.join(outside, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, path.join(root, 'drop'))
    await rejectsWith(files.upload(root, 'drop', { path: drop }, true), 'invalid_params')
    await rm(path.join(root, 'drop'))
    await mkdir(path.join(root, 'drop'))
    await symlink(elsewhere, path.join(root, 'drop/sub'))
    await rejectsWith(files.upload(root, 'drop', { path: drop }, true), 'invalid_params')
    expect(await exists(path.join(elsewhere, 'b.txt'))).toBe(false)
    await mkdir(path.join(root, 'in'))
    await rejectsWith(files.upload(root, 'in/copy', { path: root }, false), 'invalid_params')
    await rejectsWith(
      files.upload(root, 'copy', { path: path.dirname(root) }, false),
      'invalid_params',
    )
    expect(await exists(path.join(root, 'in/copy'))).toBe(false)
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
      ignored: ['logs/a.log'],
      ignoredFolders: ['src/tmp'],
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
      ignored: [],
      ignoredFolders: [],
      truncated: false,
    })
  })
})

describe('FilesService ignored entries', () => {
  async function repository() {
    const exec = createExec(() => process.env).exec
    const project = await setup(exec)
    const git = (...args: string[]) => exec('git', args, { cwd: project.root, timeoutMs: 10_000 })
    expect((await git('init', '-q')).code).toBe(0)
    return { ...project, git }
  }

  const write = async (root: string, relative: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), '')
  }

  it('names ignored folders once, without going into them, and ignored files apart', async () => {
    const { root, files, git } = await repository()
    await writeFile(path.join(root, '.gitignore'), 'dist/\nnode_modules\n*.log\n')
    for (const file of [
      'src/main.ts',
      'src/debug.log',
      'dist/a.js',
      'dist/deep/b.js',
      'node_modules/pkg/index.js',
      'logs/only.log',
      'deep/er/x.log',
    ]) {
      await write(root, file)
    }
    await git('add', '.gitignore', 'src/main.ts')
    expect(await files.list(root)).toEqual({
      paths: ['.gitignore', 'src/main.ts'],
      folders: [],
      ignored: ['deep/er/x.log', 'logs/only.log', 'src/debug.log'],
      ignoredFolders: ['dist', 'node_modules'],
      truncated: false,
    })
  })

  it('goes into an ignored folder that holds a tracked file', async () => {
    const { root, files, git } = await repository()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    await write(root, 'dist/kept.js')
    await write(root, 'dist/built.js')
    await write(root, 'dist/sub/c.js')
    await git('add', '-f', 'dist/kept.js')
    expect(await files.list(root)).toMatchObject({
      paths: ['.gitignore', 'dist/kept.js'],
      ignored: ['dist/built.js'],
      ignoredFolders: ['dist/sub'],
    })
  })

  it('counts ignored entries against the list limit', async () => {
    const exec = createExec(() => process.env).exec
    const base = await setup(exec)
    const files = new FilesService({
      exec,
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      media: async () => null,
      describeMedia: async () => null,
      trash: async () => {},
      limits: { list: 3 },
    })
    const { root } = base
    await exec('git', ['init', '-q'], { cwd: root, timeoutMs: 10_000 })
    await writeFile(path.join(root, '.gitignore'), '*.log\n')
    for (const file of ['a.ts', 'a.log', 'b.log', 'c.log']) await write(root, file)
    expect(await files.list(root)).toMatchObject({
      paths: ['.gitignore', 'a.ts'],
      ignored: ['a.log'],
      ignoredFolders: [],
      truncated: true,
    })
  })

  it('lists the top of a project whose own folder git ignores', async () => {
    const { root, files } = await repository()
    await writeFile(path.join(root, '.gitignore'), 'build/\n')
    await write(root, 'build/a.js')
    await write(root, 'build/out/b.js')
    expect(await files.list(path.join(root, 'build'))).toEqual({
      paths: [],
      folders: [],
      ignored: ['a.js'],
      ignoredFolders: ['out'],
      truncated: false,
    })
  })

  it('lists a folder by its direct children, without .git or links that leave', async () => {
    const { root, outside, files } = await setup()
    await write(root, 'dist/a.js')
    await write(root, 'dist/sub/b.js')
    await write(root, 'dist/.git/HEAD')
    await write(root, 'src/x.ts')
    await writeFile(path.join(outside, 'far.js'), '')
    await symlink(path.join(root, 'src'), path.join(root, 'dist/inside'))
    await symlink(outside, path.join(root, 'dist/away'))
    await symlink(path.join(outside, 'far.js'), path.join(root, 'dist/far.js'))
    expect(await files.listFolder(root, 'dist')).toEqual({
      files: ['dist/a.js', 'dist/far.js'],
      folders: ['dist/inside', 'dist/sub'],
      truncated: false,
    })
    expect(await files.listFolder(root, 'dist/sub')).toEqual({
      files: ['dist/sub/b.js'],
      folders: [],
      truncated: false,
    })
  })

  it('refuses to list a folder out of the project, in .git or that is a file', async () => {
    const { root, outside, files } = await setup()
    await write(root, 'dist/a.js')
    await symlink(outside, path.join(root, 'away'))
    await rejectsWith(files.listFolder(root, '../outside'), 'invalid_params')
    await rejectsWith(files.listFolder(root, 'away'), 'invalid_params')
    await rejectsWith(files.listFolder(root, '.git'), 'invalid_params')
    await rejectsWith(files.listFolder(root, 'dist/a.js'), 'invalid_params')
    await rejectsWith(files.listFolder(root, ''), 'invalid_params')
  })
})
