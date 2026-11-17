import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installArchive,
  listArchiveInstalls,
  removeStaleArchives,
  type InstalledArchive,
} from './archive-install'
import { detectAgent, type AgentDefinition, type DetectContext } from './catalog'
import { orderInstalls, type VersionChoice } from './harness-versions'
import { tempFolder } from './testing/temp'

const PROGRAM = '#!/bin/sh\necho tool\n'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** Serves `body` as the program a registry entry names. */
async function serve(body: string): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(body)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/tool`
}

/** An archive install as Kettu records it, written straight to disk. */
async function installed(root: string, version: string, installedAt: number): Promise<string> {
  const dir = path.join(root, 'harn', version)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'tool'), PROGRAM, { mode: 0o755 })
  const record = { version, url: 'https://example.com/tool', sha256: sha256(PROGRAM) }
  await writeFile(
    path.join(dir, 'installed.json'),
    JSON.stringify({ ...record, cmd: './tool', installedAt }),
  )
  return dir
}

const archive = (version: string, installedAt: number): InstalledArchive => ({
  version,
  dir: `/kettu/harnesses/harn/${version}`,
  url: 'https://example.com/tool',
  sha256: 'ab'.repeat(32),
  cmd: './tool',
  args: [],
  installedAt,
})

describe('an update from a registry archive', () => {
  it('installs beside the current version, which a start runs once it is wanted', async () => {
    const root = await tempFolder('kettu-archive-')
    await installed(root, '1.0.0', 1)
    const url = await serve(PROGRAM)
    const update = await installArchive({
      root,
      agentId: 'harn',
      version: '1.1.0',
      url,
      sha256: sha256(PROGRAM),
      cmd: './tool',
      bare: true,
      platform: process.platform,
      timeoutMs: 10_000,
    })
    expect(update.version).toBe('1.1.0')
    const installs = await listArchiveInstalls(root, 'harn')
    expect(installs.map((install) => install.version).sort()).toEqual(['1.0.0', '1.1.0'])
    expect(orderInstalls(installs, { wanted: '1.1.0', ran: '1.0.0' }).runs[0]?.version).toBe(
      '1.1.0',
    )
  })

  it('installs nothing when the download does not match the hash, and the current one stays', async () => {
    const root = await tempFolder('kettu-archive-')
    const current = await installed(root, '1.0.0', 1)
    const before = await readFile(path.join(current, 'installed.json'), 'utf8')
    const url = await serve('#!/bin/sh\necho tampered\n')
    await expect(
      installArchive({
        root,
        agentId: 'harn',
        version: '1.1.0',
        url,
        sha256: sha256(PROGRAM),
        cmd: './tool',
        bare: true,
        platform: process.platform,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/does not match its SHA-256/)
    expect(await readdir(path.join(root, 'harn'))).toEqual(['1.0.0'])
    expect(await readFile(path.join(current, 'installed.json'), 'utf8')).toBe(before)
  })
})

describe('the archive install a start runs', () => {
  const versions = (installs: InstalledArchive[], choice: VersionChoice): string[] =>
    orderInstalls(installs, choice).runs.map((install) => install.version)

  it('is the version wanted, then the one that ran, then the newest', () => {
    const installs = [archive('1.2.0', 1), archive('0.9.0', 2), archive('1.0.0', 3)]
    expect(versions(installs, { wanted: '1.0.0', ran: '0.9.0' })).toEqual([
      '1.0.0',
      '0.9.0',
      '1.2.0',
    ])
    expect(versions(installs, { wanted: '2.0.0', ran: '0.9.0' })[0]).toBe('0.9.0')
    const again = { ...archive('1.0.0', 9), dir: '/kettu/harnesses/harn/again' }
    expect(orderInstalls([...installs, again], { wanted: '1.0.0' }).runs[0]?.dir).toBe(again.dir)
  })

  it('follows a downgrade to an older version that is installed', () => {
    const installs = [archive('1.0.0', 1), archive('1.1.0', 2)]
    expect(versions(installs, { wanted: '1.0.0', ran: '1.1.0' })[0]).toBe('1.0.0')
  })

  it('never runs a version that failed to start, or one below the catalog minimum', () => {
    const installs = [archive('0.9.0', 1), archive('1.0.0', 2), archive('1.1.0', 3)]
    expect(versions(installs, { wanted: '1.1.0', failed: '1.1.0', ran: '1.0.0' })).toEqual([
      '1.0.0',
      '0.9.0',
    ])
    expect(versions(installs, { wanted: '1.1.0', minimum: '1.0.0' })).toEqual(['1.1.0', '1.0.0'])
  })

  it('runs a vendor release from the bundled version up, the newest first', () => {
    const installs = [archive('1.2.0', 1), archive('0.9.0', 2), archive('1.0.0', 3)]
    const { runs, below } = orderInstalls(installs, { wanted: '1.0.0', floor: true })
    expect(runs.map((install) => install.version)).toEqual(['1.2.0', '1.0.0'])
    expect(below?.version).toBe('0.9.0')
  })

  const def: AgentDefinition = {
    id: 'harn',
    name: 'Harn',
    registryId: 'harn',
    launch: { kind: 'binary', command: 'harn', args: ['serve', 'acp'] },
    install: { hint: 'detect.hint.archive', url: 'https://harnlang.com' },
    installs: { archive: {} },
  }

  const context = (
    installs: InstalledArchive[],
    executable: (file: string) => boolean,
  ): DetectContext => ({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    nodeRuntime: { command: '/usr/bin/node', env: {} },
    binaryOverride: null,
    node: { nodeVersion: null, npmPath: null, nodePath: null },
    adaptersDir: '/kettu/harnesses',
    versions: { wanted: '1.1.0', ran: '1.0.0' },
    isExecutable: async (file) => executable(file),
    installedArchives: async () => installs,
  })

  it('runs the wanted version Kettu installed, and names the release it runs', async () => {
    const installs = [archive('1.0.0', 1), archive('1.1.0', 2)]
    const found = await detectAgent(
      def,
      context(installs, (file) => file.includes('/harn/')),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/kettu/harnesses/harn/1.1.0/tool', version: '1.1.0' },
      release: { version: '1.1.0', dir: '/kettu/harnesses/harn/1.1.0' },
    })
  })

  it('runs the version before when the update cannot run', async () => {
    const installs = [archive('1.0.0', 1), archive('1.1.0', 2)]
    const found = await detectAgent(
      def,
      context(installs, (file) => file.includes('/1.0.0/')),
    )
    expect(found).toMatchObject({ release: { version: '1.0.0' } })
  })

  it('names no release when the user program on PATH runs', async () => {
    const installs = [archive('1.0.0', 1)]
    const found = await detectAgent(
      def,
      context(installs, (file) => file === '/usr/bin/harn'),
    )
    expect(found).toMatchObject({ state: 'available', spec: { command: '/usr/bin/harn' } })
    expect(found).not.toHaveProperty('release')
  })
})

describe('the archive installs an update replaces', () => {
  it('keeps the one before the version that runs to fall back to, and removes the older', async () => {
    const root = await tempFolder('kettu-archive-')
    await installed(root, '0.9.0', 1)
    await installed(root, '1.0.0', 2)
    const keep = await installed(root, '1.1.0', 3)
    await installed(root, '1.2.0', 4)
    await mkdir(path.join(root, 'harn', '.extensions'))
    const [current] = (await listArchiveInstalls(root, 'harn')).filter((i) => i.dir === keep)
    expect(await removeStaleArchives(root, 'harn', current!)).toEqual(['0.9.0'])
    expect((await readdir(path.join(root, 'harn'))).sort()).toEqual([
      '.extensions',
      '1.0.0',
      '1.1.0',
      '1.2.0',
    ])
  })
})
