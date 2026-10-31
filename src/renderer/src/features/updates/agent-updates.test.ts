import { describe, expect, it } from 'vitest'
import type { AgentCli, AgentStatus, AgentTask, AgentUpdate } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import {
  agentUpdateLabel,
  agentUpdateNotice,
  offerRoute,
  type AgentUpdateOffer,
} from './agent-updates'

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

describe('agentUpdateNotice', () => {
  it('shows nothing without an update', () => {
    expect(agentUpdateNotice([])).toBeNull()
    expect(agentUpdateNotice([status('codex', null)])).toBeNull()
    expect(agentUpdateNotice([status('codex', null), status('claude-code', null)])).toBeNull()
  })

  it('offers the agent version that a package update brings', () => {
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
      ]),
    ).toEqual({ kind: 'one', offer: claudeOffer })
  })

  it("names the package's versions when the update brings no newer agent", () => {
    expect(
      agentUpdateNotice([status('codex', { adapterVersion: '2.2.3', cliVersion: null })]),
    ).toEqual({ kind: 'one', offer: codexOffer })
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.300' }),
      ]),
    ).toEqual({
      kind: 'one',
      offer: {
        ...claudeOffer,
        from: '0.90.0',
        to: '0.95.0',
        package: { name: 'claude-code-acp', versions: true },
      },
    })
  })

  it("offers the user's own program by its own command", () => {
    const notice = agentUpdateNotice([status('codex', null, { cli: codexCli })])
    expect(notice).toEqual({
      kind: 'one',
      offer: {
        agentId: 'codex',
        name: 'Codex',
        from: '0.168.0',
        to: '0.170.0',
        command: 'npm install -g @openai/codex@latest',
        method: 'npm',
        package: null,
      },
    })
    expect(notice?.kind === 'one' && offerRoute(notice.offer)).toBe('cli')
    expect(offerRoute(codexOffer)).toBe('package')
  })

  it("puts the user's program before Kettu's package when both have an update", () => {
    const notice = agentUpdateNotice([
      status('codex', { adapterVersion: '2.2.3', cliVersion: null }, { cli: codexCli }),
    ])
    expect(notice?.kind === 'one' && notice.offer.command).toBe(
      'npm install -g @openai/codex@latest',
    )
  })

  it('lists several harnesses', () => {
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }),
      ]),
    ).toEqual({ kind: 'many', offers: [claudeOffer, codexOffer] })
  })

  it('leaves out a skipped update', () => {
    expect(
      agentUpdateNotice([
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }, { updateSkipped: true }),
      ]),
    ).toBeNull()
    expect(
      agentUpdateNotice([
        status(
          'claude-code',
          { adapterVersion: '0.95.0', cliVersion: '2.1.310' },
          { updateSkipped: true },
        ),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }),
      ]),
    ).toEqual({ kind: 'one', offer: codexOffer })
  })

  it('shows each harness once, through its default agent', () => {
    const update = { adapterVersion: '2.2.3', cliVersion: null }
    expect(
      agentUpdateNotice([status('codex', update), status('codex~work', update, { name: 'Work' })]),
    ).toEqual({ kind: 'one', offer: codexOffer })
  })

  it('shows an update that is running, with its command, over the others', () => {
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }, { task }),
      ]),
    ).toEqual({
      kind: 'running',
      agentId: 'codex',
      name: 'Codex',
      command: 'npm install fake-adapter@2.2.3',
    })
  })

  it('leaves out an install that is running', () => {
    expect(
      agentUpdateNotice([status('codex', null, { task: { ...task, kind: 'install' } })]),
    ).toBeNull()
  })

  it('shows a failed update with its reason and the route to retry it', () => {
    const failed = { ...task, state: 'failed' as const, error: 'npm exited with code 1' }
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
        status('codex', null, { task: failed, updateSkipped: true }),
      ]),
    ).toEqual({
      kind: 'failed',
      agentId: 'codex',
      name: 'Codex',
      error: 'npm exited with code 1',
      retry: 'package',
    })
    const notice = agentUpdateNotice([
      status('codex', null, { cli: codexCli, task: { ...failed, method: 'npm' } }),
    ])
    expect(notice?.kind === 'failed' && notice.retry).toBe('cli')
  })

  it('puts a running update before a failed one', () => {
    const failed = { ...task, state: 'failed' as const, error: 'npm exited with code 1' }
    expect(
      agentUpdateNotice([
        status('claude-code', null, { task: failed }),
        status('codex', null, { task }),
      ])?.kind,
    ).toBe('running')
  })

  it('shows a request that failed without a task', () => {
    expect(
      agentUpdateNotice([status('codex', null, { cli: codexCli })], {
        codex: { kind: 'update', message: 'npm was not found' },
      }),
    ).toEqual({
      kind: 'failed',
      agentId: 'codex',
      name: 'Codex',
      error: 'npm was not found',
      retry: 'cli',
    })
    expect(
      agentUpdateNotice([status('codex', null)], {
        codex: { kind: 'install', message: 'npm was not found' },
      }),
    ).toBeNull()
  })
})

describe('agentUpdateLabel', () => {
  it('names the card', () => {
    expect(agentUpdateLabel({ kind: 'one', offer: claudeOffer })).toBe(
      'Claude Code can be updated to 2.1.310',
    )
    expect(agentUpdateLabel({ kind: 'many', offers: [claudeOffer, codexOffer] })).toBe(
      'Agent updates 2',
    )
    expect(
      agentUpdateLabel({ kind: 'running', agentId: 'codex', name: 'Codex', command: 'x' }),
    ).toBe('Updating Codex')
    expect(
      agentUpdateLabel({
        kind: 'failed',
        agentId: 'codex',
        name: 'Codex',
        error: 'x',
        retry: 'package',
      }),
    ).toBe('Codex could not be updated')
  })
})
