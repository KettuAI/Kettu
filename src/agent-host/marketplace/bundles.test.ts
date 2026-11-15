import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundleRef, CommunityListing } from '@shared/market-community'
import type { MarketListing } from '@shared/market-publish'
import type { MarketServer } from '@shared/marketplace'
import { bundlesFile, MarketBundlesService, parseBundlesFile } from './bundles'

const spawned = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  const count =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      spawned.calls++
      return fn(...args)
    }
  return {
    ...real,
    spawn: count(real.spawn),
    execFile: count(real.execFile),
    exec: count(real.exec),
    fork: count(real.fork),
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-bundles-'))
  spawned.calls = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const log = () => {}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

const MANIFEST = {
  manifest_version: '0.3',
  name: 'echo',
  display_name: 'Echo',
  version: '1.0.0',
  description: 'Echo.',
  author: { name: 'Bea' },
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js', '${user_config.dir}'],
      env: { ECHO_KEY: '${user_config.key}' },
    },
  },
  user_config: {
    key: { type: 'string', title: 'Key', sensitive: true, required: true },
    dir: { type: 'directory', title: 'Folder', required: true },
  },
}

async function bundle(entries: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(MANIFEST))
  zip.file('server/index.js', 'console.log(1)')
  for (const [name, data] of Object.entries(entries)) zip.file(name, data)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function listing(version = '1.0.0'): MarketListing {
  return {
    id: 'abcdefgh23',
    handle: 'bea',
    slug: 'echo',
    name: 'Echo',
    kind: 'mcp-server',
    description: 'Echo.',
    visibility: 'public',
    version,
    versions: [version],
    installs: 1,
    updatedAt: '2026-11-14T00:00:00.000Z',
    mine: false,
  }
}

function service(
  data: Buffer,
  over: {
    ref?: BundleRef
    version?: string
    servers?: () => MarketServer[]
    fetch?: typeof fetch
    find?: (command: string) => Promise<string | null>
    /** What the download gives, when the listing changed after its page was read. */
    downloaded?: { version?: string; data?: Buffer }
  } = {},
) {
  const ref = over.ref ?? {
    from: 'upload',
    path: 'echo.mcpb',
    size: data.byteLength,
    sha256: sha(data),
  }
  const page: CommunityListing = {
    state: 'listed',
    listing: listing(over.version),
    server: null,
    bundle: ref,
  }
  return new MarketBundlesService({
    userDataPath: root,
    file: bundlesFile(root, log),
    log,
    platform: 'darwin',
    home: '/Users/bea',
    nodeVersion: '24.0.0',
    listing: () => Promise.resolve(page),
    download: () =>
      Promise.resolve({
        listing: listing(over.downloaded?.version ?? over.version),
        files: [{ path: 'echo.mcpb', data: over.downloaded?.data ?? data }],
      }),
    find: over.find ?? ((command) => Promise.resolve(`/usr/bin/${command}`)),
    servers: over.servers ?? (() => []),
    ...(over.fetch ? { fetch: over.fetch } : {}),
  })
}

/** Every file under the host's data, by its path there. */
async function written(): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

const mcpb = (...parts: string[]) => path.join('marketplace', 'mcpb', ...parts)

describe('MarketBundlesService', () => {
  it('stages a bundle and runs nothing until Install, then moves it into place', async () => {
    const bundles = service(await bundle())
    const plan = await bundles.prepare('abcdefgh23')
    expect(plan).toMatchObject({
      name: 'Echo',
      version: '1.0.0',
      type: 'node',
      runs: 'node server/index.js <Folder>',
      blocked: null,
      previous: null,
    })
    expect(plan.inputs.map((input) => [input.key, input.env, input.args])).toEqual([
      ['key', 'ECHO_KEY', false],
      ['dir', null, true],
    ])
    expect(spawned.calls).toBe(0)
    const staged = await written()
    expect(staged.every((file) => file.startsWith(mcpb(`.partial-${plan.token}`)))).toBe(true)

    const server = await bundles.commit(plan.token!, { dir: '/tmp/work', key: 'never stored' })
    const dir = path.join(root, mcpb('abcdefgh23', '1.0.0'))
    expect(server).toMatchObject({
      id: 'kettu:abcdefgh23',
      spec: {
        type: 'stdio',
        command: 'node',
        runtime: 'node',
        args: [path.join(dir, 'server/index.js'), '/tmp/work'],
        env: [{ name: 'ECHO_KEY', input: true, secret: true, required: true }],
      },
    })
    expect(spawned.calls).toBe(0)
    await bundles.flush()
    const records = JSON.parse(await readFile(path.join(root, 'state/market-bundles.json'), 'utf8'))
    expect(records.servers['kettu:abcdefgh23']).toEqual({
      listingId: 'abcdefgh23',
      version: '1.0.0',
      dir,
      args: { dir: '/tmp/work' },
    })
    expect(JSON.stringify(records)).not.toContain('never stored')
    await expect(bundles.commit(plan.token!, { dir: '/tmp/work' })).rejects.toThrow(/again/)
  })

  it('stages nothing for a bundle that cannot install, whatever is wrong with it', async () => {
    const unsafe = await bundle({ 'A.js': '1', 'a.js': '2' })
    await expect(service(unsafe).prepare('abcdefgh23')).rejects.toThrow(/path/)
    const python = await bundle()
    const zip = await JSZip.loadAsync(python)
    zip.file(
      'manifest.json',
      JSON.stringify({
        ...MANIFEST,
        server: { ...MANIFEST.server, type: 'python', mcp_config: { command: 'python3' } },
      }),
    )
    const blocked = await service(await zip.generateAsync({ type: 'nodebuffer' }), {
      find: () => Promise.resolve(null),
    }).prepare('abcdefgh23')
    expect(blocked).toMatchObject({ token: null, blocked: expect.stringMatching(/Python 3/) })
    expect(await written()).toEqual([])
    expect(spawned.calls).toBe(0)
  })

  it('refuses an https bundle whose SHA-256 or size is wrong, keeping nothing', async () => {
    const data = await bundle()
    const answer = (body: Buffer, headers: Record<string, string> = {}) =>
      (() =>
        Promise.resolve(
          Object.defineProperty(new Response(new Uint8Array(body), { headers }), 'url', {
            value: 'https://example.com/echo.mcpb',
          }),
        )) as unknown as typeof fetch
    const ref = (sha256: string): BundleRef => ({
      from: 'url',
      url: 'https://example.com/echo.mcpb',
      sha256,
    })
    await expect(
      service(data, { ref: ref('0'.repeat(64)), fetch: answer(data) }).prepare('abcdefgh23'),
    ).rejects.toThrow(/checksum/)
    await expect(
      service(data, {
        ref: ref(sha(data)),
        fetch: answer(data, { 'content-length': String(60 * 1024 * 1024) }),
      }).prepare('abcdefgh23'),
    ).rejects.toThrow(/larger/)
    expect(await written()).toEqual([])
    const plan = await service(data, { ref: ref(sha(data)), fetch: answer(data) }).prepare(
      'abcdefgh23',
    )
    expect(plan.token).not.toBeNull()
  })

  it('refuses an uploaded bundle that is not the one its page named, keeping nothing', async () => {
    const data = await bundle()
    const other = await bundle({ 'extra.js': '1' })
    const page = (size: number, sha256: string): BundleRef => ({
      from: 'upload',
      path: 'echo.mcpb',
      size,
      sha256,
    })
    await expect(
      service(data, { ref: page(data.byteLength + 1, sha(data)) }).prepare('abcdefgh23'),
    ).rejects.toThrow(/checksum/)
    await expect(
      service(data, { ref: page(data.byteLength, sha(other)) }).prepare('abcdefgh23'),
    ).rejects.toThrow(/checksum/)
    await expect(
      service(data, { downloaded: { version: '1.1.0', data: other } }).prepare('abcdefgh23'),
    ).rejects.toThrow(/changed/)
    expect(await written()).toEqual([])
    expect(spawned.calls).toBe(0)
  })

  it('commits nothing for a value that leads out of the folder past an =', async () => {
    const zip = await JSZip.loadAsync(await bundle())
    zip.file(
      'manifest.json',
      JSON.stringify({
        ...MANIFEST,
        server: {
          ...MANIFEST.server,
          mcp_config: { command: 'node', args: ['${__dirname}/${user_config.dir}'] },
        },
        user_config: { dir: { type: 'string', required: true } },
      }),
    )
    const bundles = service(await zip.generateAsync({ type: 'nodebuffer' }))
    const plan = await bundles.prepare('abcdefgh23')
    const dir = path.join(root, mcpb('abcdefgh23', '1.0.0'))
    await expect(
      bundles.commit(plan.token!, { dir: `../../outside=${dir}/server/index.js` }),
    ).rejects.toThrow(/path/)
    await expect(stat(dir)).rejects.toThrow()
    await bundles.flush()
    await expect(stat(path.join(root, 'state/market-bundles.json'))).rejects.toThrow()
  })

  it('removes a staged bundle on cancel', async () => {
    const bundles = service(await bundle())
    const plan = await bundles.prepare('abcdefgh23')
    await bundles.cancel(plan.token!)
    expect(await written()).toEqual([])
  })

  it('removes what no server uses: old versions, leftovers and records of servers gone', async () => {
    let servers: MarketServer[] = []
    const bundles = service(await bundle(), { servers: () => servers })
    const plan = await bundles.prepare('abcdefgh23')
    const server = await bundles.commit(plan.token!, { dir: '/tmp/work' })
    const dir = path.join(root, mcpb('abcdefgh23', '1.0.0'))
    const old = path.join(root, mcpb('abcdefgh23', '0.9.0'))
    await mkdir(old, { recursive: true })
    await writeFile(path.join(root, mcpb('.partial-left')), 'x')
    servers = [
      {
        id: server.id,
        name: 'echo',
        title: 'Echo',
        source: 'kettu',
        version: '1.0.0',
        spec: server.spec,
        agents: 'all',
        on: true,
      },
    ]
    await bundles.sweep()
    expect((await stat(dir)).isDirectory()).toBe(true)
    await expect(stat(old)).rejects.toThrow()
    await expect(stat(path.join(root, mcpb('.partial-left')))).rejects.toThrow()

    servers = []
    await bundles.sweep()
    await bundles.flush()
    await expect(stat(dir)).rejects.toThrow()
    const records = JSON.parse(await readFile(path.join(root, 'state/market-bundles.json'), 'utf8'))
    expect(records.servers).toEqual({})
  })
})

describe('parseBundlesFile', () => {
  it('drops records that name no listing, a relative folder or odd values', () => {
    const good = { listingId: 'abcdefgh23', version: '1.0.0', dir: '/data/x', args: { dir: '/a' } }
    const parsed = parseBundlesFile({
      servers: {
        'kettu:abcdefgh23': good,
        'kettu:zzzzzzzz23': { ...good, listingId: 'zzzzzzzz23', dir: 'relative' },
        'kettu:yyyyyyyy23': { ...good, listingId: 'yyyyyyyy23', args: { dir: 1 } },
        'kettu:xxxxxxxx23': { ...good },
        other: { ...good, listingId: 'other' },
      },
    })
    expect(parsed).toEqual({ version: 1, servers: { 'kettu:abcdefgh23': good } })
  })
})
