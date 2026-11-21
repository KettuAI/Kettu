// What the install window is told an install brings before it runs, and which installs a session
// start may still run without the user's click.

import { describe, expect, it } from 'vitest'
import type { InstalledAdapter } from './adapter-install'
import { AUGGIE } from './agents/auggie'
import { CLAUDE_CODE } from './agents/claude-code'
import { CODEX } from './agents/codex'
import { DEEPSEEK } from './agents/deepseek'
import { DROID } from './agents/droid'
import { GEMINI } from './agents/gemini'
import { GOOSE } from './agents/goose'
import { KIMI } from './agents/kimi'
import { MINION } from './agents/minion'
import { installPlans, type ArchiveEntry } from './binary-install'
import type { AdapterPlan } from './catalog'
import {
  installOffer,
  installsOnStart,
  npmConfigKeys,
  parseNpmConfig,
  type OfferInput,
} from './install-offer'
import type { NodeProbe } from './shell-env'

const HOME = '/home/me'
const ROOT = '/home/me/.kettu/harnesses'
const NODE: NodeProbe = {
  nodePath: '/usr/bin/node',
  nodeVersion: 'v24.11.0',
  npmPath: '/usr/bin/npm',
}

const NPM_CONFIG = parseNpmConfig(
  [
    'registry=https://registry.npmjs.org/',
    'prefix=/usr/local',
    '@moonshot-ai:registry=https://npm.example.com/',
  ].join('\n'),
)

function input(over: Partial<OfferInput> & Pick<OfferInput, 'def'>): OfferInput {
  return {
    platform: 'linux',
    home: HOME,
    root: ROOT,
    plans: [],
    copy: null,
    node: NODE,
    uv: false,
    npm: NPM_CONFIG,
    ...over,
  }
}

const lookup = (found: Record<string, string>) => ({
  platform: 'linux' as const,
  env: { PATH: '/usr/bin:/opt/homebrew/bin' },
  npm: '/usr/bin/npm',
  root: ROOT,
  isExecutable: async (file: string) => Object.values(found).includes(file),
})

describe("an npm package harness's install", () => {
  it("offers Kettu's copy first, at the version a first install takes, with the package's size", async () => {
    const plans = await installPlans(KIMI.installs!, {
      ...lookup({}),
      agentId: 'kimi',
    })
    const offer = installOffer(
      input({ def: KIMI, plans, copy: { version: '2.7.2', bytes: 4_200_000 } }),
    )
    expect(offer.routes.map((route) => route.id)).toEqual(['copy', 'npm'])
    expect(offer.routes[0]).toEqual({
      id: 'copy',
      command: null,
      available: true,
      details: {
        what: { kind: 'npm', name: '@moonshot-ai/kimi-code' },
        version: '2.7.2',
        source: { kind: 'npm', registry: 'https://npm.example.com/' },
        folder: '/home/me/.kettu/harnesses/kimi',
        size: { bytes: 4_200_000, packageOnly: true },
        needs: [
          { kind: 'node', minimum: '22.19.0', found: 'v24.11.0', ok: true },
          { kind: 'npm', ok: true },
        ],
      },
    })
  })

  it("lists the vendor's global command, its newest version into npm's global folder", async () => {
    const plans = await installPlans(KIMI.installs!, { ...lookup({}), agentId: 'kimi' })
    const offer = installOffer(input({ def: KIMI, plans, copy: { version: '2.7.2', bytes: null } }))
    expect(offer.routes[1]).toEqual({
      id: 'npm',
      command: 'npm install -g @moonshot-ai/kimi-code',
      available: true,
      details: {
        what: { kind: 'command' },
        version: null,
        source: { kind: 'npm', registry: 'https://npm.example.com/' },
        folder: '/usr/local/bin',
        size: null,
        needs: [
          { kind: 'node', minimum: '22.19.0', found: 'v24.11.0', ok: true },
          { kind: 'npm', ok: true },
        ],
      },
    })
    expect(offer.routes[0]?.details.size).toBeNull()
  })

  it('says what is missing when Node.js is too old or npm is gone', () => {
    const old = installOffer(
      input({
        def: KIMI,
        copy: { version: '2.7.2', bytes: null },
        node: { ...NODE, nodeVersion: 'v22.11.0' },
      }),
    )
    expect(old.routes[0]?.details.needs).toEqual([
      { kind: 'node', minimum: '22.19.0', found: 'v22.11.0', ok: false },
      { kind: 'npm', ok: true },
    ])
    const none = installOffer(
      input({
        def: GEMINI,
        copy: { version: '0.66.0', bytes: null },
        node: { nodePath: null, nodeVersion: null, npmPath: null },
        npm: null,
      }),
    )
    expect(none.routes).toHaveLength(1)
    expect(none.routes[0]?.details).toMatchObject({
      source: { kind: 'npm', registry: null },
      needs: [
        { kind: 'node', minimum: '22', found: null, ok: false },
        { kind: 'npm', ok: false },
      ],
    })
  })
})

describe("a package harness's vendor routes and guide", () => {
  it("lists Gemini CLI's global npm command and its install page", async () => {
    const plans = await installPlans(GEMINI.installs!, { ...lookup({}), agentId: 'gemini' })
    const offer = installOffer(
      input({ def: GEMINI, plans, copy: { version: '0.70.0', bytes: null } }),
    )
    expect(offer.routes.map((route) => [route.id, route.command])).toEqual([
      ['copy', null],
      ['npm', 'npm install -g @google/gemini-cli'],
    ])
    expect(offer.guide).toBe('https://geminicli.com/docs/get-started/installation/')
  })

  it("lists Droid's script, Homebrew cask and npm commands, the script first on macOS", async () => {
    const plans = await installPlans(DROID.installs!, {
      ...lookup({ brew: '/opt/homebrew/bin/brew', sh: '/usr/bin/sh', curl: '/usr/bin/curl' }),
      platform: 'darwin',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      agentId: 'droid',
    })
    const offer = installOffer(
      input({ def: DROID, plans, platform: 'darwin', copy: { version: '1.17.0', bytes: null } }),
    )
    expect(offer.routes.map((route) => [route.id, route.command])).toEqual([
      ['copy', null],
      ['brew', 'brew install --cask droid'],
      ['script', 'curl -fsSL https://app.factory.ai/cli | sh'],
      ['npm', 'npm install -g droid'],
    ])
    expect(offer.routes[2]?.details.folder).toBe('/home/me/.local/bin')
    expect(offer.guide).toBe('https://docs.factory.com/droid-cli/quickstart')
  })

  it("lists Auggie's documented install at its prerelease tag", async () => {
    const plans = await installPlans(AUGGIE.installs!, { ...lookup({}), agentId: 'auggie' })
    const offer = installOffer(
      input({ def: AUGGIE, plans, copy: { version: '0.30.0', bytes: null } }),
    )
    expect(offer.routes.map((route) => [route.id, route.command])).toEqual([
      ['copy', null],
      ['npm', 'npm install -g @augmentcode/auggie@prerelease'],
    ])
    expect(offer.guide).toBe('https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli')
  })

  it("offers only Kettu's copy, and the guide, for a harness whose docs list no global install", () => {
    const offer = installOffer(
      input({ def: DEEPSEEK, copy: { version: '0.2.2-rc.5', bytes: null } }),
    )
    expect(offer.routes.map((route) => route.id)).toEqual(['copy'])
    expect(offer.guide).toBe('https://github.com/deepseek-ai/deepseek-harness#run')
  })
})

describe('a harness installed from a release archive or by its vendor', () => {
  it("names the archive the ACP Registry lists, its version and Kettu's folder", async () => {
    const entry: ArchiveEntry = {
      url: 'https://github.com/block/goose/releases/download/v1.59.2/goose-x86_64-unknown-linux-gnu.tar.bz2',
      sha256: 'ab'.repeat(32),
      cmd: './goose',
      args: ['acp'],
    }
    const plans = await installPlans(GOOSE.installs!, {
      ...lookup({}),
      agentId: 'goose',
      archive: { version: '1.59.2', entry },
    })
    const offer = installOffer(input({ def: GOOSE, plans }))
    expect(offer.routes).toEqual([
      {
        id: 'archive',
        command: entry.url,
        available: true,
        details: {
          what: { kind: 'archive', name: 'goose-x86_64-unknown-linux-gnu.tar.bz2' },
          version: '1.59.2',
          source: { kind: 'registry', url: entry.url },
          folder: '/home/me/.kettu/harnesses/goose',
          size: null,
          needs: [],
        },
      },
    ])
  })

  it("says where the vendor's script and Homebrew put the program, at the vendor's newest", async () => {
    const plans = await installPlans(CODEX.installs!, {
      ...lookup({ brew: '/opt/homebrew/bin/brew', sh: '/usr/bin/sh', curl: '/usr/bin/curl' }),
      platform: 'darwin',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      agentId: 'codex',
    })
    const offer = installOffer(input({ def: CODEX, plans, platform: 'darwin' }))
    expect(offer.routes.map((route) => [route.id, route.details])).toEqual([
      [
        'script',
        {
          what: { kind: 'command' },
          version: null,
          source: { kind: 'vendor', url: 'https://chatgpt.com/codex/install.sh' },
          folder: '/home/me/.local/bin',
          size: null,
          needs: [],
        },
      ],
      [
        'brew',
        {
          what: { kind: 'command' },
          version: null,
          source: { kind: 'brew' },
          folder: '/opt/homebrew/bin',
          size: null,
          needs: [],
        },
      ],
      [
        'npm',
        {
          what: { kind: 'command' },
          version: null,
          source: { kind: 'npm', registry: 'https://registry.npmjs.org/' },
          folder: '/usr/local/bin',
          size: null,
          needs: [{ kind: 'npm', ok: true }],
        },
      ],
    ])
  })
})

describe('a uvx harness', () => {
  it('installs nothing now: uv fetches it from PyPI on the first start, and needs uv', () => {
    const offer = installOffer(input({ def: MINION, copy: { version: '0.1.45', bytes: null } }))
    expect(offer.routes).toEqual([
      {
        id: 'copy',
        command: null,
        available: false,
        firstStart: true,
        details: {
          what: { kind: 'uvx', name: 'minion-code' },
          version: '0.1.45',
          source: { kind: 'pypi' },
          folder: null,
          size: null,
          needs: [{ kind: 'uv', ok: false }],
        },
      },
    ])
  })
})

describe("npm's configuration", () => {
  it("asks for the registry, the global prefix and each scoped package's registry", () => {
    expect(npmConfigKeys(['@moonshot-ai/kimi-code', 'cline', '@moonshot-ai/kimi-code'])).toEqual([
      'registry',
      'prefix',
      '@moonshot-ai:registry',
    ])
  })

  it('reads the lines npm prints, leaving out what is not set', () => {
    const config = parseNpmConfig(
      'registry=https://registry.npmjs.org/\r\nprefix=C:\\Users\\me\\AppData\\Roaming\\npm\n@google:registry=undefined\n',
    )
    expect([...config]).toEqual([
      ['registry', 'https://registry.npmjs.org/'],
      ['prefix', 'C:\\Users\\me\\AppData\\Roaming\\npm'],
    ])
  })
})

describe('a session start', () => {
  const adapter = (over: Partial<AdapterPlan> = {}): AdapterPlan => ({
    package: '@google/gemini-cli',
    version: '0.66.0',
    installed: false,
    current: null,
    node: '/usr/bin/node',
    nodeVersion: 'v24.11.0',
    npm: '/usr/bin/npm',
    fallback: null,
    ...over,
  })
  const older: InstalledAdapter = {
    version: '0.65.0',
    dir: `${ROOT}/gemini/0.65.0`,
    entry: `${ROOT}/gemini/0.65.0/node_modules/@google/gemini-cli/bin.js`,
    installedAt: 1,
  }

  it("installs no missing copy of a package harness, but Claude Code's SDK beside its CLI", () => {
    expect(installsOnStart(GEMINI, adapter())).toBe(false)
    expect(
      installsOnStart(CLAUDE_CODE, adapter({ package: '@anthropic-ai/claude-agent-sdk' })),
    ).toBe(true)
  })

  it('installs the version wanted beside an older copy, which it falls back to', () => {
    const spec = { command: '/usr/bin/node', args: [older.entry], env: {}, shell: false }
    const fallback = { version: older.version, dir: older.dir, spec: { ...spec, display: spec } }
    expect(installsOnStart(GEMINI, adapter({ fallback }))).toBe(true)
  })
})
