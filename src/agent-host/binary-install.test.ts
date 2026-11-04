import { describe, expect, it } from 'vitest'
import { installPlans, updatePlan, type BinaryInstalls, type PlanContext } from './binary-install'

const context: PlanContext = {
  platform: 'darwin',
  arch: 'arm64',
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
})
