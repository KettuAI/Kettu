import path from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
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

  it('reads a signed bundle, its signature cut off', async () => {
    const data = await zip({ 'manifest.json': JSON.stringify(MANIFEST) })
    const signed = Buffer.concat([
      data,
      Buffer.from('MCPB_SIG_V1'),
      Buffer.alloc(4),
      Buffer.from('sig'),
      Buffer.from('MCPB_SIG_END'),
    ])
    expect((await unpackBundle(signed)).manifest.name).toBe('echo')
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
