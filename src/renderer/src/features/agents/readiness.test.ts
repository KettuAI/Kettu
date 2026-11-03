import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { listedInstalled, showsCurrent } from './readiness'

const status = (overrides: Partial<AgentStatus>): AgentStatus => ({
  id: 'codex',
  name: 'Codex',
  harnessId: 'codex',
  harnessName: 'Codex',
  isDefault: true,
  hidden: false,
  apiKey: null,
  state: 'available',
  version: null,
  package: null,
  signIn: 'unknown',
  authMethods: [],
  canLogout: false,
  account: null,
  limits: [],
  detail: null,
  installUrl: null,
  progress: [],
  launchCommand: 'codex-acp',
  binaryOverride: null,
  binaryCommand: null,
  update: null,
  updateCheckedAt: null,
  updateSkipped: false,
  task: null,
  installMethods: [],
  cli: null,
  configDir: null,
  kettuServer: { runs: true, active: true },
  capabilities: {
    loadSession: false,
    listSessions: false,
    resumeSession: false,
    closeSession: false,
    deleteSession: false,
    forkSession: false,
    forkAtMessage: false,
    steering: false,
    reports: false,
    context: false,
    account: false,
    progressNotes: false,
    mcpHttp: true,
    prompt: null,
  },
  ...overrides,
})

const adapter = (installed: boolean) => ({
  name: '@zed-industries/codex-acp',
  version: '2.2.2',
  installed,
})

describe('listedInstalled', () => {
  it('lists an agent that can run now as installed', () => {
    expect(listedInstalled(status({ package: adapter(true) }))).toBe(true)
    expect(listedInstalled(status({ id: 'opencode', state: 'ready' }))).toBe(true)
  })

  it('lists a package agent with its adapter not installed yet as one to install', () => {
    expect(listedInstalled(status({ package: adapter(false) }))).toBe(false)
  })

  it('keeps it there while its adapter installs, until the install is done', () => {
    expect(listedInstalled(status({ state: 'installing', package: adapter(false) }))).toBe(false)
    expect(listedInstalled(status({ state: 'starting', package: adapter(true) }))).toBe(true)
  })

  it('lists an agent whose program or Node.js is missing as not installed', () => {
    expect(listedInstalled(status({ id: 'opencode', state: 'not-installed' }))).toBe(false)
    expect(listedInstalled(status({ state: 'node-missing', package: adapter(false) }))).toBe(false)
  })

  it('keeps a failed agent with the installed ones, where its error and retry are', () => {
    expect(listedInstalled(status({ state: 'failed', package: adapter(true) }))).toBe(true)
  })
})

describe('showsCurrent', () => {
  it('calls an installed harness current after a check, or from its own program', () => {
    expect(showsCurrent(status({ updateCheckedAt: 1 }))).toBe(true)
    expect(
      showsCurrent(
        status({
          cli: {
            command: 'codex',
            installed: { path: '/codex', version: '1', variable: null, problem: null },
            method: null,
            update: null,
          },
        }),
      ),
    ).toBe(true)
  })

  it('does not call a missing program current from an earlier check', () => {
    expect(
      showsCurrent(
        status({ id: 'pi', harnessId: 'pi', state: 'not-installed', updateCheckedAt: 1 }),
      ),
    ).toBe(false)
    expect(showsCurrent(status({ state: 'node-missing', updateCheckedAt: 1 }))).toBe(false)
  })

  it('does not call a harness current while its package is still to install, or after uninstall', () => {
    expect(showsCurrent(status({ package: adapter(false), updateCheckedAt: 1 }))).toBe(false)
    expect(showsCurrent(status({ uninstalled: true, updateCheckedAt: 1 }))).toBe(false)
  })
})
