import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { decideUpdate } from './agent-updates'
import type { AgentDefinition } from './catalog'
import {
  fetchRegistry,
  followsRegistry,
  parseRegistry,
  registryRelease,
  type RegistryAgents,
} from './registry'

const HASH = 'ab'.repeat(32)
const RELEASE = 'https://github.com/burin-labs/harn/releases/download/v0.10.201'

const LISTING = {
  version: '1.0.0',
  agents: [
    {
      id: 'harn',
      version: '0.10.201',
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: `${RELEASE}/harn-aarch64-apple-darwin.tar.gz`,
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: HASH.toUpperCase(),
          },
          'linux-x86_64': {
            archive: `${RELEASE}/harn-linux`,
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: HASH,
          },
          'windows-x86_64': { archive: `${RELEASE}/harn.zip`, cmd: 'harn.exe' },
          'linux-aarch64': {
            archive: `${RELEASE}/harn-aarch64.tar.gz`,
            cmd: './harn',
            sha256: 'not-a-hash',
          },
        },
      },
    },
    {
      id: 'plain-http',
      version: '1.0.0',
      distribution: {
        binary: {
          'darwin-aarch64': { archive: 'http://example.com/a.tar.gz', cmd: './a', sha256: HASH },
        },
      },
    },
    {
      id: 'escaping',
      version: '../../1.0.0',
      distribution: {
        binary: {
          'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a', sha256: HASH },
        },
      },
    },
    {
      id: 'fast-agent',
      version: '0.10.2',
      distribution: { uvx: { package: 'fast-agent-acp==0.10.2', args: ['-x'] } },
    },
    {
      id: 'minion-code',
      version: '0.1.46',
      distribution: { uvx: { package: 'minion-code@0.1.46', args: ['acp'] } },
    },
    { id: 'renamed', version: '2.0.0', distribution: { uvx: { package: 'other-tool==2.0.0' } } },
    {
      id: 'shell-version',
      version: '2.0.0',
      distribution: { uvx: { package: 'fast-agent-acp==2.0.0; rm -rf ~' } },
    },
  ],
}

function agents(): RegistryAgents {
  const parsed = parseRegistry(LISTING)
  if (!parsed) throw new Error('the listing did not parse')
  return parsed
}

type Def = Pick<AgentDefinition, 'registryId' | 'launch' | 'installs'>

const binary = (registryId: string): Def => ({
  registryId,
  launch: { kind: 'binary', command: 'harn', args: ['serve', 'acp'] },
  installs: { archive: { version: '0.10.180', entries: {} } },
})

const uvx = (registryId: string, pkg = 'fast-agent-acp'): Def => ({
  registryId,
  launch: { kind: 'uvx', package: pkg, version: '0.10.1', args: ['-x'] },
})

describe('which harnesses follow the registry', () => {
  it('follows it for registry archives and uvx packages only', () => {
    expect(followsRegistry(binary('harn'))).toBe(true)
    expect(followsRegistry(uvx('fast-agent'))).toBe(true)
    expect(
      followsRegistry({
        registryId: 'muse',
        launch: { kind: 'binary', command: 'muse', args: ['acp'] },
        installs: { archive: { version: '1.0.0', entries: {}, fromVendor: true } },
      }),
    ).toBe(false)
    expect(
      followsRegistry({
        registryId: 'opencode',
        launch: { kind: 'binary', command: 'opencode', args: ['acp'] },
        installs: { brew: 'opencode' },
      }),
    ).toBe(false)
    expect(
      followsRegistry({
        registryId: 'gemini',
        launch: { kind: 'package', package: '@google/gemini-cli', version: '0.68.0' },
      }),
    ).toBe(false)
  })
})

describe('the latest release the registry lists', () => {
  it('reads the archive, its hash and the program for this platform', () => {
    expect(registryRelease(agents(), binary('harn'), 'darwin', 'arm64')).toEqual({
      kind: 'archive',
      version: '0.10.201',
      entry: {
        url: `${RELEASE}/harn-aarch64-apple-darwin.tar.gz`,
        sha256: HASH,
        cmd: './harn',
        args: ['serve', 'acp'],
      },
    })
  })

  it('takes a download that is no archive as the program itself', () => {
    const found = registryRelease(agents(), binary('harn'), 'linux', 'x64')
    expect(found).toMatchObject({ kind: 'archive', entry: { bare: true } })
  })

  it('offers nothing without a SHA-256 to check the download against', () => {
    expect(registryRelease(agents(), binary('harn'), 'win32', 'x64')).toHaveProperty('reason')
    expect(registryRelease(agents(), binary('harn'), 'linux', 'arm64')).toHaveProperty('reason')
  })

  it('offers nothing for a platform the registry does not list', () => {
    expect(registryRelease(agents(), binary('harn'), 'win32', 'arm64')).toHaveProperty('reason')
  })

  it('offers nothing downloaded over plain http', () => {
    expect(registryRelease(agents(), binary('plain-http'), 'darwin', 'arm64')).toHaveProperty(
      'reason',
    )
  })

  it('offers no version that is not plain x.y.z, since it names the install folder', () => {
    expect(registryRelease(agents(), binary('escaping'), 'darwin', 'arm64')).toHaveProperty(
      'reason',
    )
  })

  it('offers nothing for a harness the registry does not list', () => {
    expect(registryRelease(agents(), binary('gone'), 'darwin', 'arm64')).toHaveProperty('reason')
  })

  it('reads a uvx package version written either way', () => {
    expect(registryRelease(agents(), uvx('fast-agent'), 'darwin', 'arm64')).toEqual({
      kind: 'uvx',
      version: '0.10.2',
    })
    expect(registryRelease(agents(), uvx('minion-code', 'minion_code'), 'linux', 'x64')).toEqual({
      kind: 'uvx',
      version: '0.1.46',
    })
  })

  it('offers nothing when the uvx entry names another package or an odd version', () => {
    expect(registryRelease(agents(), uvx('renamed'), 'darwin', 'arm64')).toHaveProperty('reason')
    expect(registryRelease(agents(), uvx('shell-version'), 'darwin', 'arm64')).toHaveProperty(
      'reason',
    )
  })

  it('offers nothing of another kind than the harness runs', () => {
    expect(registryRelease(agents(), binary('fast-agent'), 'darwin', 'arm64')).toHaveProperty(
      'reason',
    )
    expect(registryRelease(agents(), uvx('harn'), 'darwin', 'arm64')).toHaveProperty('reason')
  })
})

describe('the update a registry release offers', () => {
  const offered = (latest: string, running: string) =>
    decideUpdate(
      { adapterVersion: latest, cliVersion: null },
      { version: running, cliVersion: null },
    )

  it('offers a newer version than the one that runs, and nothing else', () => {
    expect(offered('4020.10.0', '3893.5.0')?.adapterVersion).toBe('4020.10.0')
    expect(offered('2026.11.13', '2026.10.22')?.adapterVersion).toBe('2026.11.13')
    expect(offered('0.10.201', '0.10.201')).toBeNull()
    // Kettu pins a newer version than the registry lists when the listed one is broken.
    expect(offered('0.1.44', '0.1.45')).toBeNull()
  })
})

describe('reading the listing', () => {
  let server: Server | null = null

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  async function serve(status: number, body: string): Promise<string> {
    server = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/registry.json`
  }

  it('reads the agents of the listing by id', async () => {
    const url = await serve(200, JSON.stringify(LISTING))
    const read = await fetchRegistry({ url, timeoutMs: 5_000 })
    expect([...read.keys()]).toContain('harn')
    expect(registryRelease(read, uvx('fast-agent'), 'darwin', 'arm64')).toEqual({
      kind: 'uvx',
      version: '0.10.2',
    })
  })

  it('rejects a listing it cannot read', async () => {
    const url = await serve(200, '<html>maintenance</html>')
    await expect(fetchRegistry({ url, timeoutMs: 5_000 })).rejects.toThrow(/could not be read/)
    expect(parseRegistry({ version: '1.0.0' })).toBeNull()
  })

  it('rejects an answer that is not a success', async () => {
    const url = await serve(503, '{}')
    await expect(fetchRegistry({ url, timeoutMs: 5_000 })).rejects.toThrow(/HTTP 503/)
  })
})
