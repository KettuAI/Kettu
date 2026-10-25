import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { listedInstalled } from './readiness'

const status = (overrides: Partial<AgentStatus>): AgentStatus => ({
  id: 'codex',
  name: 'Codex',
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
  update: null,
  updateCheckedAt: null,
  task: null,
  installMethods: [],
  cli: null,
  configDir: null,
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
    account: false,
    progressNotes: false,
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
