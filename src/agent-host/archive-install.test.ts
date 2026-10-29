// Installing a release archive: a fake archive served from a local HTTP server, in each of the
// registry's formats, with and without a hash.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import {
  installArchive,
  listArchiveInstalls,
  programPath,
  type ArchiveInstallOptions,
} from './archive-install'
import { archiveTar, archiveZip, serveArchives, sha256 } from './testing/archives'
import { tempFolder } from './testing/temp'

const CONTENT = Buffer.from('#!/bin/sh\necho fake\n')
const FILE_MODE = 0o100755
const platform = process.platform as Platform
const posix = process.platform !== 'win32'

const TAR = archiveTar([{ name: 'agent', data: CONTENT, mode: FILE_MODE }])
const TAR_GZ = gzipSync(TAR)
// bzip2 of the same tar; Node.js has no bzip2 encoder, so the bytes are kept as a fixture.
const TAR_BZ2 = Buffer.from(
  'QlpoOTFBWSZTWRPORboAAC5bgcqQaADXgAAIe+meAAACCAggAFRSNGjRhDTRgGmglEg0aAA0BoaQdFVBsogWwVpc6idAUH8SQvjh5jSI1RB7EGNd93+TU+mRBo+DQhbqlwA10SNyL0D4UuBdyRThQkBPORbo',
  'base64',
)
const ZIP = archiveZip([{ name: 'agent', data: CONTENT, mode: FILE_MODE }])

function options(
  root: string,
  url: string,
  overrides: Partial<ArchiveInstallOptions> = {},
): ArchiveInstallOptions {
  return {
    root,
    agentId: 'opencode',
    version: '1.0.0',
    url,
    cmd: './agent',
    platform,
    timeoutMs: 60_000,
    ...overrides,
  }
}

async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort()
}

describe('installArchive', () => {
  it('downloads a .tar.gz whose hash matches, extracts it, and records the install', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (await serveArchives({ '/agent.tar.gz': TAR_GZ }))('/agent.tar.gz')
    const installed = await installArchive(options(root, url, { sha256: sha256(TAR_GZ) }))
    expect(installed).toMatchObject({
      version: '1.0.0',
      url,
      sha256: sha256(TAR_GZ),
      cmd: './agent',
      args: [],
    })
    const dir = path.join(root, 'opencode', '1.0.0')
    expect(await readFile(path.join(dir, 'agent'))).toEqual(CONTENT)
    if (posix) expect((await stat(path.join(dir, 'agent'))).mode & 0o777).toBe(0o755)
    expect(await entries(path.join(root, 'opencode'))).toEqual(['1.0.0'])
    expect(await listArchiveInstalls(root, 'opencode')).toEqual([installed])
  })

  it('refuses a hash that does not match, and leaves nothing behind', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (await serveArchives({ '/agent.tar.gz': TAR_GZ }))('/agent.tar.gz')
    const wrong = '0'.repeat(64)
    await expect(installArchive(options(root, url, { sha256: wrong }))).rejects.toThrow(
      `expected ${wrong}`,
    )
    expect(await entries(root)).toEqual(['opencode'])
    expect(await entries(path.join(root, 'opencode'))).toEqual([])
  })

  it('records the hash it measured when the registry gives none', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (await serveArchives({ '/agent.tar.gz': TAR_GZ }))('/agent.tar.gz')
    const installed = await installArchive(options(root, url))
    expect(installed.sha256).toBe(sha256(TAR_GZ))
  })

  it('refuses an archive whose entry escapes the target', async () => {
    const root = await tempFolder('kettu-archive-')
    const evil = archiveZip([{ name: '../escaped.txt', data: Buffer.from('x'), mode: 0o100644 }])
    const url = (await serveArchives({ '/evil.zip': evil }))('/evil.zip')
    await expect(installArchive(options(root, url))).rejects.toThrow(/invalid relative path/)
    expect(await entries(root)).toEqual(['opencode'])
    expect(await entries(path.join(root, 'opencode'))).toEqual([])
  })

  it('refuses a command outside the install folder', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (await serveArchives({ '/agent.tar.gz': TAR_GZ }))('/agent.tar.gz')
    await expect(installArchive(options(root, url, { cmd: '../agent' }))).rejects.toThrow(
      'The archive names a program outside its folder: ../agent.',
    )
    expect(await entries(path.join(root, 'opencode'))).toEqual([])
  })

  it('extracts each of the three formats with its mode bits', async () => {
    const routes = { '/agent.tar.gz': TAR_GZ, '/agent.tar.bz2': TAR_BZ2, '/agent.zip': ZIP }
    const link = await serveArchives(routes)
    for (const name of Object.keys(routes)) {
      const root = await tempFolder('kettu-archive-')
      await installArchive(options(root, link(name)))
      const file = path.join(root, 'opencode', '1.0.0', 'agent')
      expect(await readFile(file), name).toEqual(CONTENT)
      if (posix) expect((await stat(file)).mode & 0o777, name).toBe(0o755)
    }
  })

  it('extracts a command nested in bin/ with the tree beside it', async () => {
    const root = await tempFolder('kettu-archive-')
    const tar = archiveTar([
      { name: 'bin/kimchi', data: CONTENT, mode: FILE_MODE },
      { name: 'share/kimchi/models.txt', data: Buffer.from('models'), mode: 0o100644 },
    ])
    const url = (await serveArchives({ '/kimchi.tar.gz': gzipSync(tar) }))('/kimchi.tar.gz')
    const installed = await installArchive(
      options(root, url, {
        agentId: 'kimchi',
        version: '1.22.0',
        cmd: './bin/kimchi',
        args: ['--mode', 'acp'],
      }),
    )
    const dir = path.join(root, 'kimchi', '1.22.0')
    expect(await readFile(path.join(dir, 'bin', 'kimchi'))).toEqual(CONTENT)
    expect(await readFile(path.join(dir, 'share', 'kimchi', 'models.txt'))).toEqual(
      Buffer.from('models'),
    )
    expect(installed).toMatchObject({ cmd: './bin/kimchi', args: ['--mode', 'acp'] })
    if (posix) expect((await stat(path.join(dir, 'bin', 'kimchi'))).mode & 0o777).toBe(0o755)
  })

  it('extracts a binary at the archive root with the arguments it needs', async () => {
    const root = await tempFolder('kettu-archive-')
    const tar = archiveTar([
      { name: 'harn', data: CONTENT, mode: FILE_MODE },
      { name: 'LICENSE-APACHE', data: Buffer.from('license'), mode: 0o100644 },
    ])
    const url = (await serveArchives({ '/harn.tar.gz': gzipSync(tar) }))('/harn.tar.gz')
    const installed = await installArchive(
      options(root, url, {
        agentId: 'harn',
        version: '0.10.180',
        cmd: './harn',
        args: ['serve', 'acp'],
      }),
    )
    const file = path.join(root, 'harn', '0.10.180', 'harn')
    expect(await readFile(file)).toEqual(CONTENT)
    expect(installed).toMatchObject({ cmd: './harn', args: ['serve', 'acp'] })
    if (posix) expect((await stat(file)).mode & 0o777).toBe(0o755)
  })

  it('extracts a program that sits in a folder named by the build', async () => {
    const root = await tempFolder('kettu-archive-')
    const folder = 'coco-1.0.73+180523.e6179a031de9-darwin-arm64'
    const tar = gzipSync(archiveTar([{ name: `${folder}/cortex`, data: CONTENT, mode: FILE_MODE }]))
    const url = (await serveArchives({ '/cortex.tar.gz': tar }))('/cortex.tar.gz')
    const installed = await installArchive(
      options(root, url, {
        agentId: 'cortex-code',
        version: '1.0.73',
        cmd: `./${folder}/cortex`,
        args: ['acp', 'serve'],
      }),
    )
    const program = programPath(installed.dir, installed.cmd, platform)
    expect(program).toBe(path.join(root, 'cortex-code', '1.0.73', folder, 'cortex'))
    expect(await readFile(program)).toEqual(CONTENT)
    expect(installed.args).toEqual(['acp', 'serve'])
  })

  it('writes a bare executable and makes it runnable', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (await serveArchives({ '/sigit-linux-amd64': CONTENT }))('/sigit-linux-amd64')
    const installed = await installArchive(
      options(root, url, { cmd: './sigit-linux-amd64', bare: true }),
    )
    const file = path.join(root, 'opencode', '1.0.0', 'sigit-linux-amd64')
    expect(await readFile(file)).toEqual(CONTENT)
    expect(installed).toMatchObject({ bare: true })
    if (posix) expect((await stat(file)).mode & 0o777).toBe(0o755)
  })

  it('names a download that answers with an error status', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (await serveArchives({}))('/missing.tar.gz')
    await expect(installArchive(options(root, url))).rejects.toThrow('answered HTTP 404')
    expect(await entries(path.join(root, 'opencode'))).toEqual([])
  })

  it('leaves nothing behind when the download is cancelled', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (
      await serveArchives({
        '/agent.tar.gz': (response) => {
          response.setHeader('content-length', '1000000')
          response.write(Buffer.alloc(64 * 1024))
        },
      })
    )('/agent.tar.gz')
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 50)
    await expect(installArchive(options(root, url, { signal: abort.signal }))).rejects.toThrow(
      'The install was stopped.',
    )
    expect(await entries(path.join(root, 'opencode'))).toEqual([])
  })

  it('leaves nothing behind when a stalled download reaches the time limit', async () => {
    const root = await tempFolder('kettu-archive-')
    const url = (
      await serveArchives({
        '/agent.tar.gz': (response) => {
          response.setHeader('content-length', '1000000')
          response.write(Buffer.alloc(64 * 1024))
        },
      })
    )('/agent.tar.gz')
    await expect(installArchive(options(root, url, { timeoutMs: 100 }))).rejects.toThrow(
      'did not finish downloading within 0.1 s',
    )
    expect(await entries(path.join(root, 'opencode'))).toEqual([])
  })
})

describe('programPath', () => {
  it('resolves the catalog command inside the install folder', () => {
    expect(programPath('/data/agent', './bin/tool', 'darwin')).toBe('/data/agent/bin/tool')
    expect(programPath('C:\\agent', '.\\bin\\tool.exe', 'win32')).toBe('C:\\agent\\bin\\tool.exe')
  })

  it('resolves a Windows command written without ./', () => {
    expect(programPath('C:\\agent', 'vtcode.exe', 'win32')).toBe('C:\\agent\\vtcode.exe')
  })

  it('refuses an absolute or escaping command', () => {
    expect(() => programPath('/data/agent', '/usr/bin/tool', 'darwin')).toThrow('outside')
    expect(() => programPath('/data/agent', '../tool', 'darwin')).toThrow('outside')
    expect(() => programPath('/data/agent', '.', 'darwin')).toThrow('outside')
  })
})
