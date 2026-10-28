import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import {
  installedFolder,
  installPlans,
  type BinaryInstalls,
  type PlanContext,
} from './binary-install'
import { KILO, KIMI, OPENCODE } from './catalog'

const installs = OPENCODE.installs!

function context(
  platform: Platform,
  found: string[],
  npm: string | null,
  arch = 'arm64',
): PlanContext {
  const files = new Set(found)
  return {
    platform,
    arch,
    env: platform === 'win32' ? { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' } : { PATH: '/opt/bin' },
    npm,
    root: '/data/agents',
    agentId: 'opencode',
    isExecutable: async (file) => files.has(file),
  }
}

const CURSOR_AGENT = './dist-package/cursor-agent'
const CURSOR_URL = 'https://example.com/cursor-darwin-arm64.tar.gz'
const ARCHIVE: BinaryInstalls = {
  archive: {
    version: '2026.10.22',
    entries: {
      'darwin-aarch64': {
        url: CURSOR_URL,
        sha256: 'a'.repeat(64),
        cmd: CURSOR_AGENT,
        args: ['acp'],
      },
      'linux-x86_64': {
        url: 'https://example.com/sigit-linux-amd64',
        sha256: 'b'.repeat(64),
        cmd: './sigit-linux-amd64',
        bare: true,
      },
    },
  },
}

describe('installPlans', () => {
  it('prefers Homebrew, then the script, then npm on macOS and Linux', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const plans = await installPlans(
        installs,
        context(platform, ['/opt/bin/brew', '/opt/bin/bash', '/opt/bin/curl'], '/opt/bin/npm'),
      )
      expect(plans.map(({ id, command, available }) => ({ id, command, available }))).toEqual([
        { id: 'brew', command: 'brew install anomalyco/tap/opencode', available: true },
        {
          id: 'script',
          command: 'curl -fsSL https://opencode.ai/install | bash',
          available: true,
        },
        { id: 'npm', command: 'npm install -g opencode-ai', available: true },
      ])
      expect(plans.map((plan) => plan.run)).toEqual([
        { program: '/opt/bin/brew', args: ['install', 'anomalyco/tap/opencode'] },
        {
          program: '/opt/bin/bash',
          args: ['-c', 'set -o pipefail; curl -fsSL https://opencode.ai/install | bash'],
        },
        {
          program: '/opt/bin/npm',
          args: [
            'install',
            '-g',
            'opencode-ai',
            '--no-fund',
            '--no-audit',
            '--no-update-notifier',
            '--loglevel=http',
          ],
        },
      ])
    }
  })

  it('marks a route unavailable while the tool it needs is missing', async () => {
    const plans = await installPlans(installs, context('darwin', ['/opt/bin/bash'], null))
    expect(plans.map((plan) => [plan.id, plan.available, plan.run])).toEqual([
      ['brew', false, null],
      ['script', false, null],
      ['npm', false, null],
    ])
  })

  it('offers npm alone on Windows, through its .cmd shim', async () => {
    const npm = 'C:\\Program Files\\nodejs\\npm.cmd'
    const plans = await installPlans(installs, context('win32', ['C:\\tools\\bash.exe'], npm))
    expect(plans).toEqual([
      {
        id: 'npm',
        label: 'npm install -g opencode-ai',
        command: 'npm install -g opencode-ai',
        available: true,
        run: { program: npm, args: expect.arrayContaining(['install', '-g', 'opencode-ai']) },
        tool: npm,
      },
    ])
  })

  it('lists only the routes its catalog holds', async () => {
    const plans = await installPlans(
      { npm: 'sigit' },
      context('darwin', ['/opt/bin/brew'], '/opt/bin/npm'),
    )
    expect(plans.map((plan) => plan.id)).toEqual(['npm'])
  })
})

describe('the archive route', () => {
  it('comes first, with the URL, its hash and the program inside the archive', async () => {
    const plans = await installPlans(ARCHIVE, context('darwin', [], null))
    expect(plans).toEqual([
      {
        id: 'archive',
        label: 'cursor-darwin-arm64.tar.gz',
        command: CURSOR_URL,
        available: true,
        run: null,
        tool: null,
        archive: {
          version: '2026.10.22',
          url: CURSOR_URL,
          sha256: 'a'.repeat(64),
          cmd: CURSOR_AGENT,
          args: ['acp'],
          folder: '/data/agents/opencode/2026.10.22/dist-package',
        },
      },
    ])
  })

  it('is offered only for a platform and architecture the registry ships', async () => {
    expect(await installPlans(ARCHIVE, context('darwin', [], null, 'x64'))).toEqual([])
  })

  it('marks a bare executable, which the install writes without extracting', async () => {
    const [plan] = await installPlans(ARCHIVE, context('linux', [], null, 'x64'))
    expect(plan).toMatchObject({
      label: 'sigit-linux-amd64',
      archive: {
        url: 'https://example.com/sigit-linux-amd64',
        cmd: './sigit-linux-amd64',
        bare: true,
        folder: '/data/agents/opencode/2026.10.22',
      },
    })
  })
})

describe('installedFolder', () => {
  const plan = async (platform: Platform, id: string, npm = '/opt/bin/npm') =>
    (
      await installPlans(
        installs,
        context(platform, ['/opt/homebrew/bin/brew', '/opt/bin/bash', '/opt/bin/curl'], npm),
      )
    ).find((candidate) => candidate.id === id)!

  it('names where each route puts the program', async () => {
    const ctx = (platform: Platform, prefix: string | null) => ({
      platform,
      home: platform === 'win32' ? 'C:\\Users\\me' : '/Users/me',
      npmPrefix: async () => prefix,
    })
    // brew is found through PATH, so put it there for this case.
    const brew = await installPlans(installs, {
      ...context('darwin', ['/opt/homebrew/bin/brew'], null),
      env: { PATH: '/opt/homebrew/bin' },
    })
    expect(await installedFolder(brew[0]!, installs, ctx('darwin', null))).toBe('/opt/homebrew/bin')
    expect(await installedFolder(await plan('linux', 'script'), installs, ctx('linux', null))).toBe(
      '/Users/me/.opencode/bin',
    )
    expect(
      await installedFolder(await plan('darwin', 'npm'), installs, ctx('darwin', '/usr/local')),
    ).toBe('/usr/local/bin')
    expect(
      await installedFolder(
        await plan('win32', 'npm', 'C:\\nodejs\\npm.cmd'),
        installs,
        ctx('win32', 'C:\\Users\\me\\AppData\\Roaming\\npm'),
      ),
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\npm')
    expect(await installedFolder(await plan('darwin', 'npm'), installs, ctx('darwin', null))).toBe(
      null,
    )
  })

  it("names OverBench's own archive folder", async () => {
    const [archive] = await installPlans(ARCHIVE, context('darwin', [], null))
    expect(
      await installedFolder(archive!, ARCHIVE, {
        platform: 'darwin',
        home: '/Users/me',
        npmPrefix: async () => null,
      }),
    ).toBe('/data/agents/opencode/2026.10.22/dist-package')
  })
})

describe("the registry agents' own routes", () => {
  const contextFor = (agentId: PlanContext['agentId'], platform: Platform, arch: string) =>
    ({
      platform,
      arch,
      env: {},
      npm: '/opt/bin/npm',
      root: '/data/agents',
      agentId,
      isExecutable: async () => false,
    }) satisfies PlanContext

  it('offers Kilo Code its archive first, then npm, both available', async () => {
    const plans = await installPlans(KILO.installs!, contextFor('kilo', 'darwin', 'arm64'))
    expect(plans.map(({ id, command, available }) => ({ id, command, available }))).toEqual([
      {
        id: 'archive',
        command:
          'https://github.com/Kilo-Org/kilocode/releases/download/v7.8.18/kilo-darwin-arm64.zip',
        available: true,
      },
      { id: 'npm', command: 'npm install -g @kilocode/cli', available: true },
    ])
    expect(plans[0]!.archive).toMatchObject({
      version: '7.8.18',
      cmd: './kilo',
      args: ['acp'],
      sha256: '1ea2285a2f45ec27b7fa3b644f92700adf4a91fd671aaf18ba0cb8f26c795df5',
    })
  })

  it('offers Kimi no archive on a platform the registry leaves out', async () => {
    expect(await installPlans(KIMI.installs!, contextFor('kimi', 'darwin', 'x64'))).toEqual([])
    expect(
      (await installPlans(KIMI.installs!, contextFor('kimi', 'darwin', 'arm64'))).map(
        (plan) => plan.id,
      ),
    ).toEqual(['archive'])
  })
})
