import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { FILE_MATCH_CHARS, FILE_READ_LIMIT } from '@shared/files'
import type { MediaGrantRecord } from '@shared/media'
import type { Platform } from '@shared/platform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FilesService, type FilesLimits } from './files'
import type { Exec, ExecResult } from './git/exec'
import { createSandbox, type Sandbox } from './git/test-support'
import { MediaService, mediaToken } from './media'

const platform: Platform = process.platform
const posixOnly = platform === 'win32' ? it.skip : it

let s: Sandbox
let counter = 0

beforeAll(async () => {
  s = await createSandbox()
})

afterAll(async () => {
  await s.dispose()
})

/** The grants the services handed main, newest last. */
const granted: MediaGrantRecord[] = []

function service(limits: Partial<FilesLimits> = {}, exec: Exec = s.exec): FilesService {
  const media = new MediaService({
    platform,
    homeDir: s.root,
    names: async () => false,
    grant: (record) => granted.push(record),
    random: () => Buffer.alloc(16, 7),
  })
  return new FilesService({
    exec,
    platform,
    limits,
    media: (real, info) => media.grantFile(real, info, null),
  })
}

async function repo(): Promise<string> {
  return s.initRepo(`repo-${counter++}`)
}

/** A folder that is not in a repository. */
async function plain(): Promise<string> {
  const dir = join(s.root, `plain-${counter++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function result(partial: Partial<ExecResult>): ExecResult {
  return { code: 0, stdout: '', stderr: '', failure: null, message: '', ...partial }
}

/** An exec whose answer depends on the git subcommand. */
function fakeGit(answer: (args: readonly string[]) => Partial<ExecResult>): Exec {
  return async (_file, args) => result(answer(args))
}

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

const bySite = (a: { path: string; line: number }, b: { path: string; line: number }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line

describe('list in a repository', () => {
  it('returns tracked and untracked files, skips ignored and deleted ones, and sorts', async () => {
    const dir = await repo()
    await s.commit(dir, 'a.txt', 'chore: add a')
    await s.commit(dir, 'gone.txt', 'chore: add gone')
    await s.commit(dir, 'src/deep/b.ts', 'chore: add b')
    await s.write(dir, '.gitignore', 'ignored.log\nbuild/\n')
    await s.write(dir, 'u.txt', 'untracked\n')
    await s.write(dir, 'Z.txt', 'upper\n')
    await s.write(dir, 'ignored.log', 'x\n')
    await s.write(dir, 'build/out.js', 'x\n')
    await rm(join(dir, 'gone.txt'))

    expect(await service().list(dir)).toEqual({
      // Capital letters sort before lowercase ones: a plain code unit order.
      paths: ['.gitignore', 'Z.txt', 'a.txt', 'src/deep/b.ts', 'u.txt'],
      truncated: false,
    })
  })

  it('lists the files below a project folder inside a repository, relative to it', async () => {
    const dir = await repo()
    await s.commit(dir, 'top.txt', 'chore: add top')
    await s.commit(dir, 'app/x.txt', 'chore: add x')
    await s.write(dir, 'app/y.txt', 'y\n')
    expect(await service().list(join(dir, 'app'))).toEqual({
      paths: ['x.txt', 'y.txt'],
      truncated: false,
    })
  })

  it('drops duplicates and nested repositories, and cuts at the limit', async () => {
    const exec = fakeGit((args) =>
      args.includes('--deleted') ? { stdout: 'c\0' } : { stdout: 'b\0a\0b\0nested/\0c\0d\0\0' },
    )
    expect(await service({}, exec).list('/p')).toEqual({ paths: ['a', 'b', 'd'], truncated: false })
    expect(await service({ list: 2 }, exec).list('/p')).toEqual({
      paths: ['a', 'b'],
      truncated: true,
    })
    expect((await service({ list: 3 }, exec).list('/p')).truncated).toBe(false)
  })

  it('reports a git failure other than a missing repository or git', async () => {
    const exec = fakeGit(() => ({ code: null, failure: 'timeout', message: 'timed out' }))
    await expect(service({}, exec).list('/p')).rejects.toMatchObject({ code: 'git_error' })
  })
})

describe('list without git', () => {
  it('walks the folder, skipping .git and node_modules', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'a')
    await s.write(dir, 'src/b.ts', 'b')
    await s.write(dir, 'src/deep/c.ts', 'c')
    await s.write(dir, 'node_modules/pkg/index.js', 'x')
    await s.write(dir, 'src/node_modules/pkg/index.js', 'x')
    await s.write(dir, '.git/config', 'x')
    expect(await service().list(dir)).toEqual({
      paths: ['a.txt', 'src/b.ts', 'src/deep/c.ts'],
      truncated: false,
    })
  })

  it('walks when git is not installed', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'a')
    const exec = fakeGit(() => ({ code: null, failure: 'not-found' }))
    expect(await service({}, exec).list(dir)).toEqual({ paths: ['a.txt'], truncated: false })
  })

  posixOnly('does not follow a link to a folder, but lists a link to a file', async () => {
    const dir = await plain()
    await s.write(dir, 'real/inner.txt', 'x')
    await s.write(dir, 'file.txt', 'x')
    await symlink(join(dir, 'real'), join(dir, 'folder-link'))
    await symlink(join(dir, 'file.txt'), join(dir, 'file-link'))
    await symlink(join(dir, 'missing'), join(dir, 'broken-link'))
    expect((await service().list(dir)).paths).toEqual(['file-link', 'file.txt', 'real/inner.txt'])
  })

  it('stops at the limit, keeping the shallow files, and at the depth', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', '1')
    await s.write(dir, 'b.txt', '1')
    await s.write(dir, 'd/c.txt', '1')
    expect(await service({ list: 2 }).list(dir)).toEqual({
      paths: ['a.txt', 'b.txt'],
      truncated: true,
    })
    expect((await service({ list: 3 }).list(dir)).truncated).toBe(false)

    const deep = await plain()
    await s.write(deep, 'root.txt', '1')
    await s.write(deep, 'a/top.txt', '1')
    await s.write(deep, 'a/b/c/deep.txt', '1')
    expect((await service({ depth: 1 }).list(deep)).paths).toEqual(['a/top.txt', 'root.txt'])
  })

  it('fails when the folder cannot be read', async () => {
    await expect(service().list(join(s.root, 'no-such-folder'))).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('read', () => {
  it('returns the text of a file', async () => {
    const dir = await plain()
    await s.write(dir, 'src/a.txt', 'café 你好\n')
    await s.write(dir, 'empty.txt', '')
    expect(await service().read(dir, 'src/a.txt')).toEqual({
      kind: 'text',
      path: 'src/a.txt',
      size: Buffer.byteLength('café 你好\n'),
      text: 'café 你好\n',
      version: sha256('café 你好\n'),
      editable: true,
    })
    expect(await service().read(dir, 'empty.txt')).toEqual({
      kind: 'text',
      path: 'empty.txt',
      size: 0,
      text: '',
      version: sha256(''),
      editable: true,
    })
  })

  it('keeps a byte order mark and marks text that is not valid UTF-8 as not editable', async () => {
    const dir = await plain()
    await s.write(dir, 'bom.txt', '\uFEFFhello')
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9])
    await writeFile(join(dir, 'latin1.txt'), latin)
    expect(await service().read(dir, 'bom.txt')).toMatchObject({
      text: '\uFEFFhello',
      editable: true,
    })
    expect(await service().read(dir, 'latin1.txt')).toMatchObject({
      kind: 'text',
      editable: false,
      version: sha256(latin),
    })
  })

  it('returns the normalized path', async () => {
    const dir = await plain()
    await s.write(dir, 'src/a.txt', 'x')
    expect(await service().read(dir, './src//a.txt')).toMatchObject({ path: 'src/a.txt' })
  })

  it('reports a file with a NUL byte near its start as binary', async () => {
    const dir = await plain()
    await writeFile(join(dir, 'a.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
    expect(await service().read(dir, 'a.bin')).toEqual({ kind: 'binary', path: 'a.bin', size: 4 })
  })

  it('does not read a file larger than the limit', async () => {
    const dir = await plain()
    await writeFile(join(dir, 'big.txt'), Buffer.alloc(FILE_READ_LIMIT + 1, 'a'))
    await writeFile(join(dir, 'edge.txt'), Buffer.alloc(FILE_READ_LIMIT, 'a'))
    expect(await service().read(dir, 'big.txt')).toEqual({
      kind: 'too-large',
      path: 'big.txt',
      size: FILE_READ_LIMIT + 1,
      limit: FILE_READ_LIMIT,
    })
    expect(await service().read(dir, 'edge.txt')).toMatchObject({ kind: 'text' })
    await s.write(dir, 'small.txt', 'twelve bytes')
    expect(await service({ read: 11 }).read(dir, 'small.txt')).toMatchObject({
      kind: 'too-large',
      size: 12,
    })
  })

  it('answers a picture, an SVG and a video with a grant instead of their bytes', async () => {
    const dir = await plain()
    granted.length = 0
    // A PNG header of 64 x 32, and more bytes than a text file may have.
    const png = Buffer.alloc(33 + FILE_READ_LIMIT, 1)
    Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR', 'latin1').copy(png, 0)
    png.writeUInt32BE(64, 16)
    png.writeUInt32BE(32, 20)
    await writeFile(join(dir, 'cover.PNG'), png)
    await writeFile(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const mp4 = Buffer.alloc(32)
    mp4.writeUInt32BE(32, 0)
    mp4.write('ftypisom', 4, 'latin1')
    await writeFile(join(dir, 'clip.mp4'), mp4)
    const token = mediaToken(Buffer.alloc(16, 7))

    const picture = await service().read(dir, 'cover.PNG')
    expect(picture).toEqual({
      kind: 'media',
      path: 'cover.PNG',
      grant: {
        url: expect.stringMatching(new RegExp(`^overbench-media://${token}/cover\\.PNG\\?v=\\d+$`)),
        kind: 'image',
        mimeType: 'image/png',
        size: png.length,
        width: 64,
        height: 32,
      },
    })
    expect(await service().read(dir, 'logo.svg')).toEqual({
      kind: 'media',
      path: 'logo.svg',
      grant: {
        url: expect.stringContaining('/logo.svg?v='),
        kind: 'image',
        mimeType: 'image/svg+xml',
        size: 41,
      },
    })
    expect(await service().read(dir, 'clip.mp4')).toMatchObject({
      kind: 'media',
      grant: { kind: 'video', mimeType: 'video/mp4', size: 32 },
    })
    // The Files pane's grants belong to no session, at the file's real path.
    expect(granted).toEqual(
      await Promise.all(
        [
          ['cover.PNG', 'image/png'],
          ['logo.svg', 'image/svg+xml'],
          ['clip.mp4', 'video/mp4'],
        ].map(async ([name, mimeType]) => ({
          token,
          path: await realpath(join(dir, name!)),
          mimeType,
          sessionId: null,
        })),
      ),
    )
    // A JPEG named .png is shown as what it is.
    await writeFile(join(dir, 'photo.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))
    expect(await service().read(dir, 'photo.png')).toMatchObject({
      grant: { mimeType: 'image/jpeg' },
    })
  })

  it('reads a binary that is no media, and one named as media that is not, as any other file', async () => {
    const dir = await plain()
    granted.length = 0
    await writeFile(join(dir, 'data.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))
    await s.write(dir, 'note.png', 'not a picture')
    await writeFile(join(dir, 'odd.gif'), Buffer.from([0x00, 0x01, 0x02]))
    await s.write(dir, 'fake.mp4', 'not a video')
    expect(await service().read(dir, 'data.bin')).toEqual({
      kind: 'binary',
      path: 'data.bin',
      size: 6,
    })
    expect(await service().read(dir, 'note.png')).toMatchObject({
      kind: 'text',
      text: 'not a picture',
    })
    expect(await service().read(dir, 'odd.gif')).toMatchObject({ kind: 'binary' })
    expect(await service().read(dir, 'fake.mp4')).toMatchObject({ kind: 'text' })
    expect(granted).toEqual([])
  })

  it('refuses paths that could leave the project', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'x')
    const outside = join(s.root, 'secret.txt')
    await writeFile(outside, 'secret')
    for (const path of [
      '../secret.txt',
      'sub/../../secret.txt',
      outside,
      '/etc/hosts',
      'a\0.txt',
    ]) {
      await expect(service().read(dir, path), path).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
    await expect(service().read(dir, '')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(service().read(dir, '.')).rejects.toMatchObject({ code: 'invalid_params' })
  })

  posixOnly('refuses a symbolic link that leads out of the project', async () => {
    const dir = await plain()
    const outside = await plain()
    await s.write(outside, 'secret.txt', 'secret')
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
    await symlink(outside, join(dir, 'folder-link'))
    await expect(service().read(dir, 'link.txt')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(service().read(dir, 'folder-link/secret.txt')).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })

  posixOnly('follows a symbolic link that stays inside the project', async () => {
    const dir = await plain()
    await s.write(dir, 'real/a.txt', 'inside')
    await symlink(join(dir, 'real', 'a.txt'), join(dir, 'link.txt'))
    expect(await service().read(dir, 'link.txt')).toMatchObject({ kind: 'text', text: 'inside' })
  })

  it('answers not_found for a missing file and invalid_params for a folder', async () => {
    const dir = await plain()
    await s.write(dir, 'src/a.txt', 'x')
    await expect(service().read(dir, 'nope.txt')).rejects.toMatchObject({ code: 'not_found' })
    await expect(service().read(dir, 'src/a.txt/more')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(service().read(dir, 'src')).rejects.toMatchObject({ code: 'invalid_params' })
  })

  posixOnly('does not take a sibling folder that shares the project path as a prefix', async () => {
    const dir = await plain()
    const sibling = `${dir}-extra`
    await mkdir(sibling)
    await writeFile(join(sibling, 'a.txt'), 'x')
    await symlink(join(sibling, 'a.txt'), join(dir, 'link.txt'))
    await expect(service().read(dir, 'link.txt')).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('locate', () => {
  it('names a file or a folder of the project by its path under the project', async () => {
    const dir = await plain()
    await s.write(dir, 'src/a.txt', 'x')
    expect(await service().locate(dir, 'src/a.txt')).toEqual({
      path: join(dir, 'src', 'a.txt'),
      kind: 'file',
    })
    expect(await service().locate(dir, './src/')).toEqual({
      path: join(dir, 'src'),
      kind: 'folder',
    })
  })

  it('refuses what read refuses, and answers not_found for a missing path', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'x')
    const outside = join(s.root, 'secret.txt')
    await writeFile(outside, 'secret')
    for (const path of ['../secret.txt', 'sub/../../secret.txt', outside, '', '.', 'a\0.txt']) {
      await expect(service().locate(dir, path), path).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
    await expect(service().locate(dir, 'nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  posixOnly('refuses a symbolic link that leads out of the project', async () => {
    const dir = await plain()
    const outside = await plain()
    await s.write(outside, 'secret.txt', 'secret')
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
    await symlink(outside, join(dir, 'folder-link'))
    await expect(service().locate(dir, 'link.txt')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(service().locate(dir, 'folder-link')).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})

describe('search in a repository', () => {
  it('finds lines ignoring case, with their line numbers, in tracked and untracked files', async () => {
    const dir = await repo()
    await s.commit(dir, 'a.txt', 'chore: add a', 'Hello World\nsecond\nHELLO again\n')
    await s.commit(dir, 'src/b.txt', 'chore: add b', 'nothing\nsay hello\r\n')
    await s.write(dir, '.gitignore', 'ignored.txt\n')
    await s.write(dir, 'u.txt', 'untracked hello\n')
    await s.write(dir, 'ignored.txt', 'hello ignored\n')
    await writeFile(join(dir, 'binary.dat'), Buffer.from('hello\0hello'))
    const found = await service().search(dir, 'hello')
    expect(found.truncated).toBe(false)
    expect([...found.matches].sort(bySite)).toEqual([
      { path: 'a.txt', line: 1, text: 'Hello World' },
      { path: 'a.txt', line: 3, text: 'HELLO again' },
      { path: 'src/b.txt', line: 2, text: 'say hello' },
      { path: 'u.txt', line: 1, text: 'untracked hello' },
    ])
  })

  it('has no match for text that is not there', async () => {
    const dir = await repo()
    await s.commit(dir, 'a.txt', 'chore: add a', 'hello\n')
    expect(await service().search(dir, 'absent')).toEqual({ matches: [], truncated: false })
  })

  it('searches a repository that has no commit yet', async () => {
    const dir = await repo()
    await s.write(dir, 'a.txt', 'first\nneedle\n')
    expect((await service().search(dir, 'NEEDLE')).matches).toEqual([
      { path: 'a.txt', line: 2, text: 'needle' },
    ])
  })

  it('takes the query as literal text', async () => {
    const dir = await repo()
    await s.commit(dir, 'a.txt', 'chore: add a', 'a.c\nabc\n-v flag\n(x|y)\n')
    expect((await service().search(dir, 'a.c')).matches).toEqual([
      { path: 'a.txt', line: 1, text: 'a.c' },
    ])
    expect((await service().search(dir, '-v')).matches).toEqual([
      { path: 'a.txt', line: 3, text: '-v flag' },
    ])
    expect((await service().search(dir, '(x|y)')).matches).toHaveLength(1)
    expect(await service().search(dir, 'a.c\nabc')).toEqual({ matches: [], truncated: false })
  })

  it('reports paths relative to a project folder below the top of the repository', async () => {
    const dir = await repo()
    await s.commit(dir, 'top.txt', 'chore: add top', 'needle\n')
    await s.commit(dir, 'app/x.txt', 'chore: add x', 'needle\n')
    expect((await service().search(join(dir, 'app'), 'needle')).matches).toEqual([
      { path: 'x.txt', line: 1, text: 'needle' },
    ])
  })

  it('cuts long lines and stops at the limit', async () => {
    const dir = await repo()
    await s.commit(dir, 'long.txt', 'chore: add long', `needle ${'x'.repeat(1000)}\n`)
    await s.write(dir, 'many.txt', 'needle\nneedle\nneedle\n')
    const long = (await service().search(dir, 'x'.repeat(10))).matches
    expect(long[0]!.text).toHaveLength(FILE_MATCH_CHARS)
    const limited = await service({ search: 2 }).search(dir, 'needle')
    expect(limited.matches).toHaveLength(2)
    expect(limited.truncated).toBe(true)
    expect((await service({ search: 4 }).search(dir, 'needle')).truncated).toBe(false)
  })

  it('keeps what git printed when its output hits the buffer limit', async () => {
    const exec = fakeGit(() => ({
      code: null,
      failure: 'max-buffer',
      stdout: 'a.txt\x001\x00one\nb.txt\x002\x00tw',
    }))
    expect(await service({}, exec).search('/p', 'x')).toEqual({
      matches: [{ path: 'a.txt', line: 1, text: 'one' }],
      truncated: true,
    })
  })

  it('reports a git failure', async () => {
    const exec = fakeGit(() => ({ code: null, failure: 'timeout', message: 'timed out' }))
    await expect(service({}, exec).search('/p', 'x')).rejects.toMatchObject({ code: 'git_error' })
  })

  it('refuses an empty query', async () => {
    await expect(service().search('/p', '')).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('search without git', () => {
  it('scans the files, ignoring case, binary files and node_modules', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'Hello World\nsecond\r\nsay HELLO\r\n')
    await s.write(dir, 'src/b.txt', 'nothing\n')
    await s.write(dir, 'node_modules/pkg/c.txt', 'hello\n')
    await writeFile(join(dir, 'binary.dat'), Buffer.from('hello\0hello'))
    const found = await service().search(dir, 'hello')
    expect(found.truncated).toBe(false)
    expect([...found.matches].sort(bySite)).toEqual([
      { path: 'a.txt', line: 1, text: 'Hello World' },
      { path: 'a.txt', line: 3, text: 'say HELLO' },
    ])
    expect(await service().search(dir, 'absent')).toEqual({ matches: [], truncated: false })
  })

  it('searches when git is not installed', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'needle\n')
    const exec = fakeGit(() => ({ code: null, failure: 'not-found' }))
    expect((await service({}, exec).search(dir, 'needle')).matches).toHaveLength(1)
  })

  it('skips files larger than the read limit', async () => {
    const dir = await plain()
    await s.write(dir, 'small.txt', 'needle\n')
    await s.write(dir, 'large.txt', `needle ${'x'.repeat(100)}\n`)
    expect((await service({ read: 50 }).search(dir, 'needle')).matches).toEqual([
      { path: 'small.txt', line: 1, text: 'needle' },
    ])
  })

  posixOnly('does not read through a link that leads out of the project', async () => {
    const dir = await plain()
    const outside = await plain()
    await s.write(outside, 'secret.txt', 'needle\n')
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
    expect(await service().search(dir, 'needle')).toEqual({ matches: [], truncated: false })
  })

  it('stops at the match limit and at the number of files it reads', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'needle\nneedle\nneedle\n')
    await s.write(dir, 'b.txt', 'needle\n')
    await s.write(dir, 'c.txt', 'needle\n')
    const limited = await service({ search: 3 }).search(dir, 'needle')
    expect(limited.matches).toHaveLength(3)
    expect(limited.truncated).toBe(true)
    expect((await service({ search: 5 }).search(dir, 'needle')).truncated).toBe(false)

    const partial = await service({ scanFiles: 2 }).search(dir, 'needle')
    expect(partial.matches.map((m) => m.path)).toEqual(['a.txt', 'a.txt', 'a.txt', 'b.txt'])
    expect(partial.truncated).toBe(true)
  })
})

describe('write', () => {
  it("replaces a file's text exactly and answers its new version", async () => {
    const dir = await plain()
    await s.write(dir, 'src/a.txt', 'old\n')
    const { version } = (await service().read(dir, 'src/a.txt')) as { version: string }
    const text = 'new\r\nline 你好\n'
    expect(await service().write(dir, 'src/a.txt', text, version)).toEqual({
      version: sha256(text),
      size: Buffer.byteLength(text),
    })
    expect(await readFile(join(dir, 'src/a.txt'), 'utf8')).toBe(text)
    expect(await service().read(dir, 'src/a.txt')).toMatchObject({ version: sha256(text) })
    expect(await readdir(join(dir, 'src'))).toEqual(['a.txt'])
  })

  it('refuses a version the file no longer has and writes nothing', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'first')
    const { version } = (await service().read(dir, 'a.txt')) as { version: string }
    await s.write(dir, 'a.txt', 'changed by an agent')
    await expect(service().write(dir, 'a.txt', 'mine', version)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('changed by an agent')
    expect(await service().write(dir, 'a.txt', 'mine', null)).toMatchObject({ size: 4 })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('mine')
  })

  posixOnly("keeps the file's mode", async () => {
    const dir = await plain()
    await s.write(dir, 'run.sh', 'echo hi\n')
    await chmod(join(dir, 'run.sh'), 0o754)
    await service().write(dir, 'run.sh', 'echo bye\n', null)
    expect((await stat(join(dir, 'run.sh'))).mode & 0o777).toBe(0o754)
  })

  posixOnly('writes a file with other hard links in place, so they keep sharing it', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'shared')
    await link(join(dir, 'a.txt'), join(dir, 'b.txt'))
    const before = (await stat(join(dir, 'a.txt'))).ino
    await service().write(dir, 'a.txt', 'still shared', null)
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('still shared')
    expect((await stat(join(dir, 'a.txt'))).ino).toBe(before)
  })

  posixOnly('writes through a symbolic link inside the project and keeps the link', async () => {
    const dir = await plain()
    await s.write(dir, 'real/a.txt', 'inside')
    await symlink(join(dir, 'real', 'a.txt'), join(dir, 'link.txt'))
    await service().write(dir, 'link.txt', 'edited', null)
    expect((await lstat(join(dir, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(dir, 'real', 'a.txt'), 'utf8')).toBe('edited')
  })

  it('refuses what it must not write', async () => {
    const dir = await plain()
    await s.write(dir, 'a.txt', 'x')
    await s.write(dir, '.git/config', '[core]\n')
    await s.write(dir, 'src/b.txt', 'x')
    const outside = join(s.root, `outside-${counter++}.txt`)
    await writeFile(outside, 'secret')
    for (const path of ['../outside.txt', outside, '.git/config', 'sub/.git/x', 'src']) {
      await expect(service().write(dir, path, 'y', null), path).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
    await expect(service().write(dir, 'missing.txt', 'y', null)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(service({ read: 4 }).write(dir, 'a.txt', '12345', null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(await readFile(outside, 'utf8')).toBe('secret')
    expect(await readFile(join(dir, '.git/config'), 'utf8')).toBe('[core]\n')
  })
})
