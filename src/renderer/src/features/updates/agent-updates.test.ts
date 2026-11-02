import { describe, expect, it } from 'vitest'
import type { AgentCli, AgentStatus, AgentTask, AgentUpdate } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { harnessUpdates, offerRoute, type AgentUpdateOffer } from './agent-updates'

const task: AgentTask = {
  kind: 'update',
  state: 'running',
  command: 'npm install fake-adapter@2.2.3',
  method: null,
  progress: [],
  error: null,
}

const codexCli: AgentCli = {
  command: 'codex',
  installed: { path: '/usr/local/bin/codex', version: '0.168.0', variable: null, problem: null },
  method: 'npm',
  update: { version: '0.170.0', command: 'npm install -g @openai/codex@latest' },
}

function status(
  id: AgentId,
  update: AgentUpdate | null,
  overrides: Partial<AgentStatus> = {},
): AgentStatus {
  const codex = id.startsWith('codex')
  const name = codex ? 'Codex' : 'Claude Code'
  return {
    id,
    name,
    harnessName: name,
    harnessId: codex ? 'codex' : 'claude-code',
    isDefault: !id.includes('~'),
    version: codex ? '0.168.0' : '2.1.300',
    package: codex
      ? { name: 'codex-acp', version: '2.2.1', installed: true }
      : { name: 'claude-code-acp', version: '0.90.0', installed: true },
    cli: null,
    update,
    updateCheckedAt: 1_000,
    updateSkipped: false,
    task: null,
    ...overrides,
  } as AgentStatus
}

const claudeOffer: AgentUpdateOffer = {
  agentId: 'claude-code',
  name: 'Claude Code',
  from: '2.1.300',
  to: '2.1.310',
  command: null,
  method: null,
  package: { name: 'claude-code-acp', versions: false },
}

const codexOffer: AgentUpdateOffer = {
  agentId: 'codex',
  name: 'Codex',
  from: '2.2.1',
  to: '2.2.3',
  command: null,
  method: null,
  package: { name: 'codex-acp', versions: true },
}

/** The offers alone, as the card lists them when nothing runs or failed. */
function offers(statuses: AgentStatus[]): AgentUpdateOffer[] {
  return harnessUpdates(statuses).offers.map((o) => o.offer)
}

describe('harnessUpdates', () => {
  it('has nothing without an update', () => {
    expect(harnessUpdates([])).toEqual({ running: null, failed: null, offers: [] })
    expect(harnessUpdates([status('codex', null), status('claude-code', null)])).toEqual({
      running: null,
      failed: null,
      offers: [],
    })
  })

  it('offers the agent version that a package update brings', () => {
    expect(
      offers([status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' })]),
    ).toEqual([claudeOffer])
  })

  it("names the package's versions when the update brings no newer agent", () => {
    expect(offers([status('codex', { adapterVersion: '2.2.3', cliVersion: null })])).toEqual([
      codexOffer,
    ])
    expect(
      offers([status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.300' })]),
    ).toEqual([
      {
        ...claudeOffer,
        from: '0.90.0',
        to: '0.95.0',
        package: { name: 'claude-code-acp', versions: true },
      },
    ])
  })

  it("offers the user's own program by its own command", () => {
    const [offer] = offers([status('codex', null, { cli: codexCli })])
    expect(offer).toEqual({
      agentId: 'codex',
      name: 'Codex',
      from: '0.168.0',
      to: '0.170.0',
      command: 'npm install -g @openai/codex@latest',
      method: 'npm',
      package: null,
    })
    expect(offerRoute(offer!)).toBe('cli')
    expect(offerRoute(codexOffer)).toBe('package')
  })

  it("puts the user's program before Kettu's package when both have an update", () => {
    const [offer] = offers([
      status('codex', { adapterVersion: '2.2.3', cliVersion: null }, { cli: codexCli }),
    ])
    expect(offer?.command).toBe('npm install -g @openai/codex@latest')
  })

  it('keeps a skipped update, marked, for the review list', () => {
    expect(
      harnessUpdates([
        status(
          'claude-code',
          { adapterVersion: '0.95.0', cliVersion: '2.1.310' },
          { updateSkipped: true },
        ),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }),
      ]).offers,
    ).toEqual([
      { offer: claudeOffer, skipped: true },
      { offer: codexOffer, skipped: false },
    ])
  })

  it('shows each harness once, through its default agent', () => {
    const update = { adapterVersion: '2.2.3', cliVersion: null }
    expect(
      offers([status('codex', update), status('codex~work', update, { name: 'Work' })]),
    ).toEqual([codexOffer])
  })

  it('names an update that is running, with its command, apart from the offers', () => {
    expect(
      harnessUpdates([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }, { task }),
      ]),
    ).toEqual({
      running: {
        agentId: 'codex',
        harnessId: 'codex',
        name: 'Codex',
        command: 'npm install fake-adapter@2.2.3',
        output: [],
      },
      failed: null,
      offers: [{ offer: claudeOffer, skipped: false }],
    })
  })

  it('leaves out an install that is running', () => {
    expect(
      harnessUpdates([status('codex', null, { task: { ...task, kind: 'install' } })]).running,
    ).toBeNull()
  })

  it('names a failed update with its reason, its log and the route to retry it', () => {
    const failed = {
      ...task,
      state: 'failed' as const,
      error: 'npm exited with code 1',
      progress: ['npm ERR! EACCES'],
    }
    expect(
      harnessUpdates([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
        status('codex', null, { task: failed, updateSkipped: true }),
      ]).failed,
    ).toEqual({
      agentId: 'codex',
      harnessId: 'codex',
      name: 'Codex',
      error: 'npm exited with code 1',
      retry: 'package',
      command: 'npm install fake-adapter@2.2.3',
      output: ['npm ERR! EACCES'],
    })
    expect(
      harnessUpdates([status('codex', null, { cli: codexCli, task: { ...failed, method: 'npm' } })])
        .failed?.retry,
    ).toBe('cli')
  })

  it('names a request that failed without a task', () => {
    expect(
      harnessUpdates([status('codex', null, { cli: codexCli })], {
        codex: { kind: 'update', message: 'npm was not found' },
      }).failed,
    ).toEqual({
      agentId: 'codex',
      harnessId: 'codex',
      name: 'Codex',
      error: 'npm was not found',
      retry: 'cli',
      command: null,
      output: [],
    })
    expect(
      harnessUpdates([status('codex', null)], {
        codex: { kind: 'install', message: 'npm was not found' },
      }).failed,
    ).toBeNull()
  })
})
