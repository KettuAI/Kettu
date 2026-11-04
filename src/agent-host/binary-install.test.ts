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
