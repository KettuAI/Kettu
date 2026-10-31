import { describe, expect, it } from 'vitest'
import type { AgentStatus, AgentTask, AgentUpdate } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { agentUpdateNotice } from './agent-updates'

const task: AgentTask = {
  kind: 'update',
  state: 'running',
  command: 'npm install fake-adapter@2.2.3',
  method: null,
  progress: [],
  error: null,
}

function status(
  id: AgentId,
  update: AgentUpdate | null,
  overrides: Partial<AgentStatus> = {},
): AgentStatus {
  const name = id.startsWith('codex') ? 'Codex' : 'Claude Code'
  return {
    id,
    name,
    harnessName: name,
    isDefault: !id.includes('~'),
    cli: null,
    update,
    updateCheckedAt: 1_000,
    updateSkipped: false,
    task: null,
    ...overrides,
  } as AgentStatus
}

describe('agentUpdateNotice', () => {
  it('shows nothing without an update', () => {
    expect(agentUpdateNotice([])).toBeNull()
    expect(agentUpdateNotice([status('codex', null)])).toBeNull()
    expect(agentUpdateNotice([status('codex', null), status('claude-code', null)])).toBeNull()
  })

  it('names one agent and the version its update would bring', () => {
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
      ]),
    ).toEqual({
      kind: 'one',
      agentId: 'claude-code',
      name: 'Claude Code',
      version: '2.1.310',
    })
  })

  it('falls back to the adapter version when the update brings no CLI', () => {
    expect(
      agentUpdateNotice([status('codex', { adapterVersion: '2.2.3', cliVersion: null })]),
    ).toEqual({ kind: 'one', agentId: 'codex', name: 'Codex', version: '2.2.3' })
  })

  it('counts several agents', () => {
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }),
      ]),
    ).toEqual({ kind: 'many', agentIds: ['claude-code', 'codex'] })
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
    ).toEqual({ kind: 'one', agentId: 'codex', name: 'Codex', version: '2.2.3' })
  })

  it("names the version of the user's CLI an update brings", () => {
    const cli = {
      command: 'codex',
      installed: null,
      method: 'npm' as const,
      update: { version: '0.170.0', command: 'npm install -g @openai/codex@latest' },
    }
    expect(agentUpdateNotice([status('codex', null, { cli })])).toEqual({
      kind: 'one',
      agentId: 'codex',
      name: 'Codex',
      version: '0.170.0',
    })
  })

  it('shows each harness once, through its default agent', () => {
    const update = { adapterVersion: '2.2.3', cliVersion: null }
    expect(
      agentUpdateNotice([status('codex', update), status('codex~work', update, { name: 'Work' })]),
    ).toEqual({ kind: 'one', agentId: 'codex', name: 'Codex', version: '2.2.3' })
  })

  it('leaves out an agent whose update is installing', () => {
    expect(
      agentUpdateNotice([status('codex', { adapterVersion: '2.2.3', cliVersion: null }, { task })]),
    ).toBeNull()
    expect(
      agentUpdateNotice([
        status('claude-code', { adapterVersion: '0.95.0', cliVersion: '2.1.310' }, { task }),
        status('codex', { adapterVersion: '2.2.3', cliVersion: null }),
      ]),
    ).toEqual({ kind: 'one', agentId: 'codex', name: 'Codex', version: '2.2.3' })
  })
})
