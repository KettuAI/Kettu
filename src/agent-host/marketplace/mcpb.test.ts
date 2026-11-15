import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLE_LIMITS,
  fillArgs,
  planBundle,
  readManifest,
  unpackBundle,
  type PlanContext,
} from './mcpb'

const MANIFEST = {
  manifest_version: '0.3',
  name: 'echo',
  version: '1.0.0',
  description: 'Echo.',
  author: { name: 'Bea' },
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js', '${user_config.dir}'],
      env: { API_KEY: '${user_config.key}', MODE: 'fast' },
    },
  },
  user_config: {
    key: { type: 'string', title: 'API key', sensitive: true, required: true },
    dir: { type: 'directory', title: 'Folder', required: true, default: '${HOME}/work' },
  },
}

async function zip(
  entries: Record<string, string | { data: string; unixPermissions?: number; dir?: boolean }>,
): Promise<Buffer> {
  const z = new JSZip()
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === 'string') z.file(name, value)
    else z.file(name, value.data, { unixPermissions: value.unixPermissions, dir: value.dir })
  }
  return z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}

/** A zip whose one entry is stored under exactly `name`, which JSZip itself would not write. */
async function rawName(name: string): Promise<Buffer> {
  const placeholder = 'x'.repeat(name.length)
  const data = await zip({ 'manifest.json': '{}', [placeholder]: 'hi' })
  // Both the local header and the central directory hold the name.
  return Buffer.from(data.toString('latin1').split(placeholder).join(name), 'latin1')
}

interface RawEntry {
  name: string
  data: Buffer
  /** The sizes and CRC the zip claims, when they should not be the real ones. */
  size?: number
  crc?: number
}

/** A deflated zip written by hand, so its declared sizes and CRCs can lie. */
function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const packed = deflateRawSync(entry.data)
    const crc = entry.crc ?? crc32(entry.data)
    const size = entry.size ?? entry.data.byteLength
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(packed.byteLength, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.byteLength, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(packed.byteLength, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.byteLength + name.byteLength + packed.byteLength
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A signature block as the mcpb tool appends it: marks around a length and the signature. */
function signatureBlock(signature: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signature.byteLength)
  return Buffer.concat([Buffer.from('MCPB_SIG_V1'), length, signature, Buffer.from('MCPB_SIG_END')])
}

// The inflater JSZip itself loads, to count how much of an entry it was asked to inflate.
const pako = createRequire(createRequire(import.meta.url).resolve('jszip'))('pako') as {
  Inflate: { prototype: { push(...args: unknown[]): boolean } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const DIR = path.resolve('/kettu/marketplace/mcpb/abcdefgh23/1.0.0')

function context(over: Partial<PlanContext> = {}): PlanContext {
  return {
    dir: DIR,
    platform: 'darwin',
    home: '/Users/bea',
    files: new Set(['manifest.json', 'server/index.js']),
    nodeVersion: '24.1.0',
    find: (command) => Promise.resolve(`/usr/bin/${command}`),
    ...over,
  }
}

function manifest(over: Record<string, unknown> = {}, server: Record<string, unknown> = {}) {
  return readManifest({ ...MANIFEST, ...over, server: { ...MANIFEST.server, ...server } }, 'darwin')
}

describe('unpackBundle', () => {
  it('unpacks a bundle with its manifest, keeping only the run bit', async () => {
    const data = await zip({
      'manifest.json': JSON.stringify(MANIFEST),
      'server/index.js': 'console.log(1)',
      'server/bin': { data: '#!', unixPermissions: 0o100755 },
    })
    const { files, manifest: read } = await unpackBundle(data)
    expect(read.name).toBe('echo')
    expect(files.map((f) => [f.path, f.mode]).sort()).toEqual([
      ['manifest.json', 0o644],
      ['server/bin', 0o755],
      ['server/index.js', 0o644],
    ])
  })

  it('refuses the whole bundle for any path that could leave its folder', async () => {
    for (const name of ['../evil.js', '/etc/evil', 'a/../../evil', 'C:/evil', 'a\\..\\evil']) {
      await expect(unpackBundle(await rawName(name)), name).rejects.toThrow(/path|zip/)
    }
  })

  it('refuses names that differ only in case, links and other entries', async () => {
    await expect(
      unpackBundle(await zip({ 'manifest.json': '{}', 'A.js': '1', 'a.js': '2' })),
    ).rejects.toThrow(/path/)
    await expect(
      unpackBundle(
        await zip({
          'manifest.json': '{}',
          link: { data: '/etc/passwd', unixPermissions: 0o120777 },
        }),
      ),
    ).rejects.toThrow(/link/)
    await expect(
      unpackBundle(
        await zip({ 'manifest.json': '{}', fifo: { data: '', unixPermissions: 0o010644 } }),
      ),
    ).rejects.toThrow(/link/)
  })

  it('stops inflating once the bundle is too large unpacked', async () => {
    const z = new JSZip()
    z.file('manifest.json', '{}')
    const limits = { entries: 10, unpacked: 4 * 1024 * 1024 }
    const big = Buffer.alloc(limits.unpacked / 4 + 1)
    for (let i = 0; i < 4; i++) z.file(`big${i}.bin`, big)
    const data = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(data.byteLength).toBeLessThan(64 * 1024)
    await expect(unpackBundle(data, limits)).rejects.toThrow(/larger/)
  })

  it('refuses a bundle without a manifest, or with too many entries', async () => {
    await expect(unpackBundle(await zip({ 'server.js': '1' }))).rejects.toThrow(/manifest/)
    const many: Record<string, string> = { 'manifest.json': '{}' }
    for (let i = 0; i < BUNDLE_LIMITS.entries; i++) many[`f/${i}`] = ''
    await expect(unpackBundle(await zip(many))).rejects.toThrow(/more files/)
    await expect(unpackBundle(Buffer.from('not a zip'))).rejects.toThrow(/zip/)
  })

  it('reads a signed bundle, its signature block after the zip cut off', async () => {
    const data = await zip({ 'manifest.json': JSON.stringify(MANIFEST) })
    const signed = Buffer.concat([data, signatureBlock(randomBytes(300))])
    expect((await unpackBundle(signed)).manifest.name).toBe('echo')
  })

  it('reads an unsigned bundle whose files hold the signature mark', async () => {
    const z = new JSZip()
    z.file('manifest.json', JSON.stringify(MANIFEST))
    z.file('server/index.js', 'const mark = "MCPB_SIG_V1"; const end = "MCPB_SIG_END"')
    const data = await z.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
    const { files } = await unpackBundle(data)
    expect(files.find((f) => f.path === 'server/index.js')!.data.toString()).toContain(
      'MCPB_SIG_V1',
    )
  })

  it('refuses a bigger bundle than its limit by its declared sizes, inflating nothing', async () => {
    const push = vi.spyOn(pako.Inflate.prototype, 'push')
    const data = rawZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024) },
    ])
    await expect(unpackBundle(data, { entries: 10, unpacked: 1024 * 1024 })).rejects.toThrow(
      /larger/,
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('stops inflating part-way through an entry that lies about its size', async () => {
    const push = vi.spyOn(pako.Inflate.prototype, 'push')
    // Random bytes barely deflate, so each piece fed to the inflater gives about as much out.
    const data = rawZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'big.bin', data: randomBytes(4 * 1024 * 1024), size: 100 },
    ])
    // JSZip feeds its inflater 16 KiB of the deflated entry at a time.
    const chunks = Math.ceil(data.byteLength / (16 * 1024))
    expect(chunks).toBeGreaterThan(200)
    await expect(unpackBundle(data, { entries: 10, unpacked: 1024 * 1024 })).rejects.toThrow(
      /larger/,
    )
    expect(push.mock.calls.length).toBeLessThan(chunks / 2)
  })

  it('refuses an entry whose CRC is wrong', async () => {
    const data = rawZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
      { name: 'server/index.js', data: Buffer.from('console.log(1)'), crc: 1234 },
    ])
    await expect(unpackBundle(data)).rejects.toThrow(/zip/)
  })
})

describe('readManifest', () => {
  it('refuses a manifest missing what Kettu needs', () => {
    expect(() => manifest({ manifest_version: '9.9' })).toThrow(/manifest_version/)
    expect(() => manifest({ name: undefined })).toThrow(/name/)
    expect(() => manifest({}, { type: 'ruby' })).toThrow(/server.type/)
    expect(() => manifest({}, { entry_point: '../x.js' })).toThrow(/path/)
    expect(() => manifest({ user_config: { k: { type: 'color' } } })).toThrow(/user_config/)
  })

  it('takes the platform’s override over the shared config', () => {
    const read = readManifest(
      {
        ...MANIFEST,
        server: {
          ...MANIFEST.server,
          mcp_config: {
            command: 'node',
            args: ['a'],
            env: { A: '1' },
            platform_overrides: { darwin: { env: { B: '2' } }, win32: { args: ['w'] } },
          },
        },
      },
      'darwin',
    )
    expect(read.config).toEqual({ command: 'node', args: ['a'], env: { A: '1', B: '2' } })
  })
})

describe('planBundle', () => {
  it('runs a node bundle on Kettu’s Node.js, its paths inside its folder', async () => {
    const setup = await planBundle(manifest(), context())
    expect(setup).toMatchObject({
      command: 'node',
      runtime: 'node',
      args: [path.join(DIR, 'server/index.js'), '${user_config.dir}'],
      env: [
        {
          name: 'API_KEY',
          input: true,
          secret: true,
          required: true,
          title: 'API key',
          kind: 'string',
        },
        { name: 'MODE', value: 'fast' },
      ],
      runs: 'node server/index.js <Folder>',
      blocked: null,
    })
    expect(setup.inputs).toMatchObject([
      { key: 'key', env: 'API_KEY', args: false, secret: true },
      { key: 'dir', env: null, args: true, default: '/Users/bea/work' },
    ])
  })

  it('refuses a path that leaves its folder once filled in', async () => {
    const out = manifest({}, { mcp_config: { command: 'node', args: ['${__dirname}/../x.js'] } })
    await expect(planBundle(out, context())).rejects.toThrow(/path/)
    const binary = manifest({}, { type: 'binary', mcp_config: { command: '/bin/sh' } })
    await expect(planBundle(binary, context())).rejects.toThrow(/path/)
  })

  it('refuses a variable it does not know', async () => {
    const odd = manifest({}, { mcp_config: { command: 'node', args: ['${SECRET_PATH}'] } })
    await expect(planBundle(odd, context())).rejects.toThrow(/SECRET_PATH/)
    const unknown = manifest({}, { mcp_config: { command: 'node', args: ['${user_config.nope}'] } })
    await expect(planBundle(unknown, context())).rejects.toThrow(/user_config.nope/)
  })

  it('blocks a secret on the command line, another platform, and a missing Python', async () => {
    const secretArg = manifest(
      {},
      { mcp_config: { command: 'node', args: ['server/index.js', '--key', '${user_config.key}'] } },
    )
    expect((await planBundle(secretArg, context())).blocked).toMatch(/secret/)
    const linux = manifest({ compatibility: { platforms: ['linux'] } })
    expect((await planBundle(linux, context())).blocked).toMatch(/only on linux/)
    const old = manifest({ compatibility: { runtimes: { node: '>=99.0.0' } } })
    expect((await planBundle(old, context())).blocked).toMatch(/Node.js >=99/)
    const python = manifest(
      {},
      { type: 'python', mcp_config: { command: 'python', args: ['${__dirname}/server/index.js'] } },
    )
    const none = context({ find: () => Promise.resolve(null) })
    expect((await planBundle(python, none)).blocked).toMatch(/Python 3/)
    expect((await planBundle(python, context())).command).toBe('python3')
  })

  it('runs a binary from its own folder, and a bare path of the bundle from there', async () => {
    const binary = manifest(
      {},
      { type: 'binary', entry_point: 'server/tool', mcp_config: { command: 'server/tool' } },
    )
    const files = new Set(['manifest.json', 'server/tool', 'server/index.js'])
    const setup = await planBundle(binary, context({ files }))
    expect(setup).toMatchObject({ command: path.join(DIR, 'server/tool'), program: 'server/tool' })
    const bare = manifest({}, { mcp_config: { command: 'node', args: ['server/index.js'] } })
    expect((await planBundle(bare, context())).args).toEqual([path.join(DIR, 'server/index.js')])
  })
})

describe('fillArgs', () => {
  it('fills the arguments, taking defaults and checking each value', async () => {
    const setup = await planBundle(manifest(), context())
    expect(fillArgs(setup, { dir: '/tmp/work' })).toEqual([
      path.join(DIR, 'server/index.js'),
      '/tmp/work',
    ])
    expect(fillArgs(setup, {})).toEqual([path.join(DIR, 'server/index.js'), '/Users/bea/work'])
    expect(() => fillArgs(setup, { dir: 'a\nb' })).toThrow()
    // A secret never goes on the command line, whatever is sent.
    expect(() => fillArgs({ ...setup, args: ['${user_config.key}'] }, { key: 'x' })).toThrow()
  })

  it('refuses a value or default that leads a bundle path out of its folder', async () => {
    const read = manifest(
      { user_config: { file: { type: 'string', required: false, default: '../../outside.js' } } },
      {
        mcp_config: {
          command: 'node',
          args: ['${__dirname}/${user_config.file}', '--at=${__dirname}/${user_config.file}'],
        },
      },
    )
    const setup = await planBundle(read, context())
    expect(() => fillArgs(setup, {})).toThrow(/path/)
    expect(() => fillArgs(setup, { file: '../../../etc/x.js' })).toThrow(/path/)
    expect(() => fillArgs(setup, { file: 'server/../../x.js' })).toThrow(/path/)
    expect(fillArgs(setup, { file: 'server/index.js' })).toEqual([
      path.join(DIR, 'server/index.js'),
      `--at=${path.join(DIR, 'server/index.js')}`,
    ])
    const list = manifest(
      { user_config: { files: { type: 'string', multiple: true, required: true } } },
      { mcp_config: { command: 'node', args: ['${__dirname}/${user_config.files}'] } },
    )
    const listed = await planBundle(list, context())
    expect(() => fillArgs(listed, { files: 'a.js\n../../b.js' })).toThrow(/path/)
  })

  it('checks the path after the fixed text before the folder, never after an = in a value', async () => {
    const sneaky = `../../outside=${DIR}/safe.js`
    for (const template of [
      '${__dirname}/${user_config.file}',
      '--config=${__dirname}/${user_config.file}',
    ]) {
      const read = manifest(
        { user_config: { file: { type: 'string', required: false, default: sneaky } } },
        { mcp_config: { command: 'node', args: [template] } },
      )
      const setup = await planBundle(read, context())
      expect(setup.blocked).toBeNull()
      expect(() => fillArgs(setup, {}), template).toThrow(/path/)
      expect(() => fillArgs(setup, { file: sneaky }), template).toThrow(/path/)
      expect(() => fillArgs(setup, { file: '../../x.js' }), template).toThrow(/path/)
      const prefix = template.startsWith('--config=') ? '--config=' : ''
      expect(fillArgs(setup, { file: 'server/a=b.js' })).toEqual([
        prefix + path.join(DIR, 'server/a=b.js'),
      ])
    }
  })

  it('refuses a bundle whose text before its folder holds a variable', async () => {
    const read = manifest(
      { user_config: { opt: { type: 'string', required: true } } },
      { mcp_config: { command: 'node', args: ['${user_config.opt}${__dirname}/server/index.js'] } },
    )
    await expect(planBundle(read, context())).rejects.toThrow(/path/)
  })

  it('expands a list into one argument each and checks numbers', async () => {
    const read = manifest(
      {
        user_config: {
          dirs: { type: 'directory', multiple: true, required: false },
          n: { type: 'number', min: 1, max: 5, required: true },
        },
      },
      { mcp_config: { command: 'node', args: ['${user_config.dirs}', '--n=${user_config.n}'] } },
    )
    const setup = await planBundle(read, context())
    expect(fillArgs(setup, { dirs: '/a\n/b', n: '3' })).toEqual(['/a', '/b', '--n=3'])
    expect(fillArgs(setup, { n: '3' })).toEqual(['--n=3'])
    expect(() => fillArgs(setup, { n: '9' })).toThrow()
    expect(() => fillArgs(setup, {})).toThrow(/Fill in/)
  })
})
