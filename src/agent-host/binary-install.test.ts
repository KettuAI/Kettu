import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import {
  installedFolder,
  installMethodOf,
  installPlans,
  updatePlan,
  type BinaryInstalls,
  type PlanContext,
} from './binary-install'
import { CLAUDE_CODE, CODEX, KILO, KIMI, OPENCODE } from './catalog'

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

  it("names Kettu's own archive folder", async () => {
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

describe("the routes of a harness that runs the user's CLI", () => {
  const claude = CLAUDE_CODE.installs!
  const codex = CODEX.installs!

  it("offers Claude Code its script, its cask on macOS and npm, in its maker's order", async () => {
    const tools = ['/opt/bin/brew', '/opt/bin/bash', '/opt/bin/curl']
    const mac = await installPlans(claude, context('darwin', tools, '/opt/bin/npm'))
    expect(mac.map(({ id, command }) => [id, command])).toEqual([
      ['script', 'curl -fsSL https://claude.ai/install.sh | bash'],
      ['brew', 'brew install --cask claude-code'],
      ['npm', 'npm install -g @anthropic-ai/claude-code'],
    ])
    // Casks are macOS only.
    const linux = await installPlans(claude, context('linux', tools, '/opt/bin/npm'))
    expect(linux.map((plan) => plan.id)).toEqual(['script', 'npm'])
  })

  it('offers winget on Windows, run without stopping to ask', async () => {
    const plans = await installPlans(claude, context('win32', ['C:\\tools\\winget.exe'], null))
    expect(
      plans.map(({ id, command, available, run }) => ({ id, command, available, run })),
    ).toEqual([
      {
        id: 'winget',
        command: 'winget install --id Anthropic.ClaudeCode -e',
        available: true,
        run: {
          program: 'C:\\tools\\winget.exe',
          args: ['install', '--id', 'Anthropic.ClaudeCode', '-e', '--disable-interactivity'],
        },
      },
      {
        id: 'npm',
        command: 'npm install -g @anthropic-ai/claude-code',
        available: false,
        run: null,
      },
    ])
  })

  it("runs Codex's script with sh, which gets the script only once curl succeeded", async () => {
    const plans = await installPlans(
      codex,
      context('darwin', ['/opt/bin/brew', '/opt/bin/sh', '/opt/bin/curl'], '/opt/bin/npm'),
    )
    expect(plans.map((plan) => plan.id)).toEqual(['script', 'brew', 'npm'])
    expect(plans[0]).toMatchObject({
      command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      run: {
        program: '/opt/bin/sh',
        args: [
          '-c',
          `script="$(curl -fsSL https://chatgpt.com/codex/install.sh)" && printf '%s\\n' "$script" | sh`,
        ],
      },
    })
    expect(plans[1]?.command).toBe('brew install --cask codex')
  })
})

describe('installMethodOf', () => {
  const home = '/Users/me'
  const of = (installs: BinaryInstalls, file: string, platform: Platform = 'darwin') =>
    installMethodOf(installs, file, { platform, home })

  it('tells the way a program was installed from where its file is', () => {
    const claude = CLAUDE_CODE.installs!
    expect(of(claude, '/Users/me/.local/share/claude/versions/2.1.304')).toBe('script')
    expect(of(claude, '/opt/homebrew/Caskroom/claude-code/2.1.304/claude')).toBe('brew')
    expect(of(claude, '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')).toBe(
      'npm',
    )
    expect(of(claude, '/opt/my/claude')).toBeNull()
    // A folder that only starts with the script's is not it.
    expect(of(claude, '/Users/me/.local/share/claude-other/claude')).toBeNull()
    const codex = CODEX.installs!
    expect(of(codex, '/Users/me/.codex/packages/standalone/0.170.0/codex')).toBe('script')
    expect(of(codex, '/opt/homebrew/Caskroom/codex/0.170.0/codex-aarch64-apple-darwin')).toBe(
      'brew',
    )
  })

  it('compares Windows paths without case, with either slash', () => {
    const claude = CLAUDE_CODE.installs!
    const winget =
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode\\claude.exe'
    expect(installMethodOf(claude, winget, { platform: 'win32', home: 'C:\\Users\\me' })).toBe(
      'winget',
    )
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\x'
    expect(installMethodOf(claude, npm, { platform: 'win32', home: 'C:\\Users\\me' })).toBe('npm')
  })
})

describe('updatePlan', () => {
  const ctx = (found: string[], npm: string | null = '/opt/bin/npm') => ({
    platform: 'darwin' as const,
    env: { PATH: '/opt/bin' },
    npm,
    isExecutable: async (file: string) => found.includes(file),
    program: '/Users/me/.local/bin/claude',
  })

  it("runs a script install's own update command, or the script again", async () => {
    expect(await updatePlan(CLAUDE_CODE.installs!, 'script', ctx([]))).toEqual({
      command: 'claude update',
      run: { program: '/Users/me/.local/bin/claude', args: ['update'] },
    })
    const tools = ['/opt/bin/sh', '/opt/bin/curl']
    expect(await updatePlan(CODEX.installs!, 'script', ctx(tools))).toMatchObject({
      command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      run: { program: '/opt/bin/sh' },
    })
  })

  it('upgrades a cask, a winget package or an npm package to the latest', async () => {
    expect(await updatePlan(CODEX.installs!, 'brew', ctx(['/opt/bin/brew']))).toEqual({
      command: 'brew upgrade --cask codex',
      run: { program: '/opt/bin/brew', args: ['upgrade', '--cask', 'codex'] },
    })
    expect(await updatePlan(CLAUDE_CODE.installs!, 'winget', ctx([]))).toEqual({
      command: 'winget upgrade --id Anthropic.ClaudeCode -e',
      run: null,
    })
    expect(await updatePlan(CODEX.installs!, 'npm', ctx([]))).toEqual({
      command: 'npm install -g @openai/codex@latest',
      run: {
        program: '/opt/bin/npm',
        args: expect.arrayContaining(['install', '-g', '@openai/codex@latest', '--no-fund']),
      },
    })
    // The command still shows while its tool is missing.
    expect(await updatePlan(CODEX.installs!, 'npm', ctx([], null))).toMatchObject({ run: null })
  })

  it('has no update for a route the harness does not have', async () => {
    expect(await updatePlan(CODEX.installs!, 'winget', ctx([]))).toBeNull()
    expect(await updatePlan(CODEX.installs!, 'archive', ctx([]))).toBeNull()
  })
})
