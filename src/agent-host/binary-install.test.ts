import { describe, expect, it } from 'vitest'
import {
  installPlans,
  npmPrefixOf,
  updatePlan,
  type BinaryInstalls,
  type PlanContext,
} from './binary-install'

const context: PlanContext = {
  platform: 'darwin',
  env: {},
  npm: '/usr/local/bin/npm',
  root: '/data/agents',
  agentId: 'pi',
  isExecutable: async () => false,
}

describe.each(['bash', 'sh'] as const)('the %s script route', (shell) => {
  it('quotes script arguments and preserves them on update', async () => {
    const installs = {
      script: 'https://vendor.example/install.sh',
      scriptShell: shell,
      scriptArgs: ['--non-interactive', 'two words', "it's $(false); exit 1"],
    }
    const ctx: PlanContext = {
      ...context,
      env: { PATH: '/bin' },
      isExecutable: async (file) => file === `/bin/${shell}` || file === '/bin/curl',
    }
    const [plan] = await installPlans(installs, ctx)
    const invocation = `${shell} -s -- --non-interactive 'two words' 'it'\\''s $(false); exit 1'`
    const download = 'curl -fsSL https://vendor.example/install.sh'
    expect(plan?.command).toBe(`${download} | ${invocation}`)
    expect(plan?.run).toEqual({
      program: `/bin/${shell}`,
      args: [
        '-c',
        shell === 'bash'
          ? `set -o pipefail; ${download} | ${invocation}`
          : `script="$(${download})" && printf '%s\\n' "$script" | ${invocation}`,
      ],
    })
    const update = await updatePlan(installs, 'script', { ...ctx, program: '/bin/vendor' })
    expect(update).toEqual({ command: plan?.command, run: plan?.run })
  })
})

describe('the npm route', () => {
  it('skips the package install scripts when the vendor does, on install and update', async () => {
    const installs: BinaryInstalls = { npm: 'vendor-pkg', ignoreScripts: true }
    const [plan] = await installPlans(installs, context)
    expect(plan?.id).toBe('npm')
    expect(plan?.command).toBe('npm install -g --ignore-scripts vendor-pkg')
    expect(plan?.run?.args).toContain('--ignore-scripts')

    const update = await updatePlan(installs, 'npm', { ...context, program: '/bin/pi' })
    expect(update?.command).toBe('npm install -g --ignore-scripts vendor-pkg@latest')
    expect(update?.run?.args).toContain('--ignore-scripts')
  })

  it('leaves the install scripts running when the vendor does not skip them', async () => {
    const installs: BinaryInstalls = { npm: 'vendor-pkg' }
    const [plan] = await installPlans(installs, context)
    expect(plan?.run?.args).not.toContain('--ignore-scripts')
  })

  it('updates the copy under the prefix the program was found in, whichever npm runs', async () => {
    const installs: BinaryInstalls = { npm: '@vendor/cli' }
    const update = await updatePlan(installs, 'npm', {
      ...context,
      program: '/Users/ann/.local/bin/cli',
      npmPrefix: '/Users/ann/.local',
    })
    expect(update?.command).toBe('npm install -g --prefix /Users/ann/.local @vendor/cli@latest')
    expect(update?.run?.program).toBe('/usr/local/bin/npm')
    expect(update?.run?.args.slice(0, 5)).toEqual([
      'install',
      '-g',
      '--prefix',
      '/Users/ann/.local',
      '@vendor/cli@latest',
    ])
  })

  it('reads the npm prefix from where the package lives', () => {
    const pkg = '@anthropic-ai/claude-code'
    expect(
      npmPrefixOf(
        '/Users/ann/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
        pkg,
        'darwin',
      ),
    ).toBe('/Users/ann/.local')
    expect(
      npmPrefixOf(
        'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
        pkg,
        'win32',
      ),
    ).toBe('C:\\Users\\Ann\\AppData\\Roaming\\npm')
    expect(npmPrefixOf('/Users/ann/.local/share/claude/versions/2.1.326', pkg, 'darwin')).toBeNull()
  })
})
