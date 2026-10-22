import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { installedFolder, installPlans, type PlanContext } from './binary-install'
import { OPENCODE } from './catalog'

const installs = OPENCODE.installs!

function context(platform: Platform, found: string[], npm: string | null): PlanContext {
  const files = new Set(found)
  return {
    platform,
    env: platform === 'win32' ? { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' } : { PATH: '/opt/bin' },
    npm,
    isExecutable: async (file) => files.has(file),
  }
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
        command: 'npm install -g opencode-ai',
        available: true,
        run: { program: npm, args: expect.arrayContaining(['install', '-g', 'opencode-ai']) },
        tool: npm,
      },
    ])
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
})
