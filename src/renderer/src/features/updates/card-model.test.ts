import { afterEach, describe, expect, it } from 'vitest'
import type { AgentCli, AgentStatus, AgentTask } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'
import {
  harnessOfferText,
  harnessRowNote,
  runningByHarness,
  severalNote,
  updateCard,
  updateCardLabel,
  updateItems,
  type HarnessItem,
  type UpdatesInput,
} from './card-model'

afterEach(() => i18n.changeLanguage('en'))

function cli(version: string, to: string): AgentCli {
  return {
    command: 'x',
    installed: { path: '/bin/x', version, variable: null, problem: null },
    method: 'npm',
    update: { version: to, command: `npm install -g x@${to}` },
  }
}

function agent(id: AgentId, overrides: Partial<AgentStatus> = {}): AgentStatus {
  const codex = id.startsWith('codex')
  const name = codex ? 'Codex' : 'Claude Code'
  return {
    id,
    name,
    harnessId: codex ? 'codex' : 'claude-code',
    harnessName: name,
    isDefault: !id.includes('~'),
    hidden: false,
    version: null,
    package: null,
    cli: codex ? cli('0.48', '0.49') : cli('2.4.1', '2.5.0'),
    update: null,
    updateSkipped: false,
    task: null,
    ...overrides,
  } as AgentStatus
}

const running: AgentTask = {
  kind: 'update',
  state: 'running',
  command: 'npm install -g x@0.49',
  method: 'npm',
  progress: ['added 3 packages'],
  error: null,
}

function input(overrides: Partial<UpdatesInput> = {}): UpdatesInput {
  return {
    app: null,
    statuses: [agent('claude-code'), agent('codex')],
    taskErrors: {},
    sessions: [],
    waiting: [],
    queued: [],
    ...overrides,
  }
}

const harnessIds = (items: { kind: string; offer?: { agentId: AgentId } }[]) =>
  items.map((item) => (item.kind === 'app' ? 'kettu' : item.offer!.agentId))

describe('runningByHarness', () => {
  it('counts the sessions with a turn running, by harness', () => {
    expect(
      runningByHarness([
        { agentId: 'codex', status: 'running' },
        { agentId: 'codex~work', status: 'awaiting_permission' },
        { agentId: 'codex', status: 'ready' },
        { agentId: 'claude-code', status: 'failed' },
      ]),
    ).toEqual({ codex: 2 })
  })
})

describe('updateItems', () => {
  it('puts Kettu first, then the harnesses used most', () => {
    const items = updateItems(
      input({
        app: { kind: 'ready', version: '0.1.0' },
        sessions: [
          { agentId: 'codex', status: 'ready' },
          { agentId: 'codex', status: 'ready' },
          { agentId: 'claude-code', status: 'ready' },
        ],
      }),
    )
    expect(harnessIds(items)).toEqual(['kettu', 'codex', 'claude-code'])
  })

  it('counts the agents of a harness and its running sessions, and marks what was asked for', () => {
    const items = updateItems(
      input({
        statuses: [
          agent('claude-code'),
          agent('claude-code~work', { name: 'Work' }),
          agent('claude-code~old', { hidden: true }),
          agent('codex'),
        ],
        sessions: [{ agentId: 'codex', status: 'running' }],
        waiting: ['codex'],
        queued: ['claude-code'],
      }),
    ) as HarnessItem[]
    expect(items.map(({ agents, running, waiting, queued }) => [agents, running, waiting, queued]))
      // Codex has a session, so it comes first.
      .toEqual([
        [1, 1, true, false],
        [2, 0, false, true],
      ])
  })
})

describe('updateCard', () => {
  it('shows nothing with nothing to do', () => {
    expect(updateCard(input({ statuses: [agent('codex', { cli: null })] }))).toBeNull()
  })

  it("shows Kettu's own update alone", () => {
    expect(
      updateCard(input({ statuses: [], app: { kind: 'ready', version: '0.1.0' } })),
    ).toMatchObject({ kind: 'one', item: { kind: 'app' } })
  })

  it('collapses several updates into one card, leaving skipped ones to the list', () => {
    const card = updateCard(
      input({
        app: { kind: 'ready', version: '0.1.0' },
        statuses: [agent('claude-code'), agent('codex', { updateSkipped: true })],
      }),
    )
    expect(card?.kind).toBe('several')
    expect(card?.kind === 'several' && harnessIds(card.items)).toEqual(['kettu', 'claude-code'])
  })

  it('lets "Updated to" give way to anything still to do', () => {
    const card = updateCard(
      input({
        app: { kind: 'updated', version: '0.1.0', from: '0.0.9' },
        statuses: [agent('codex')],
      }),
    )
    expect(card).toMatchObject({ kind: 'one', item: { kind: 'harness' } })
  })

  it('shows a lone update that waits for its sessions as waiting', () => {
    const card = updateCard(
      input({
        statuses: [agent('codex')],
        sessions: [{ agentId: 'codex', status: 'running' }],
        waiting: ['codex'],
      }),
    )
    expect(card).toMatchObject({ kind: 'waiting', item: { running: 1 } })
  })

  it('shows an update installing over everything, with how many follow', () => {
    const card = updateCard(
      input({
        app: { kind: 'ready', version: '0.1.0' },
        statuses: [agent('claude-code'), agent('codex', { task: running })],
        queued: ['claude-code'],
      }),
    )
    expect(card).toMatchObject({
      kind: 'installing',
      run: { kind: 'harness', run: { agentId: 'codex', output: ['added 3 packages'] } },
      percent: null,
      more: 1,
    })
  })

  it("shows the app's download with its percentage", () => {
    expect(
      updateCard(
        input({ statuses: [], app: { kind: 'downloading', version: '0.1.0', percent: 64 } }),
      ),
    ).toMatchObject({ kind: 'installing', run: { kind: 'app' }, percent: 64, more: 0 })
  })

  it('shows a failed update before those on offer', () => {
    const card = updateCard(
      input({
        statuses: [
          agent('claude-code'),
          agent('codex', { task: { ...running, state: 'failed', error: 'permission denied' } }),
        ],
      }),
    )
    expect(card).toMatchObject({ kind: 'failed', failure: { error: 'permission denied' } })
  })
})

describe('the card in words', () => {
  const [claude] = updateItems(
    input({ statuses: [agent('claude-code'), agent('claude-code~work'), agent('codex')] }),
  ) as HarnessItem[]

  it('names the version jump and who depends on it', () => {
    expect(harnessOfferText(claude!)).toEqual({
      title: 'Claude Code 2.5.0',
      note: '2.4.1 → 2.5.0 · 2 agents use it',
    })
    expect(harnessOfferText({ ...claude!, agents: 1 }).note).toBe('2.4.1 → 2.5.0')
  })

  it("says what a row's update waits for", () => {
    expect(harnessRowNote(claude!)).toBe('Installs in the background')
    expect(harnessRowNote({ ...claude!, running: 1 })).toBe('Waits for 1 running session')
    expect(harnessRowNote({ ...claude!, skipped: true })).toBe('Skipped this version')
  })

  it('counts Kettu and the harnesses', () => {
    expect(
      severalNote([{ kind: 'app', notice: { kind: 'ready', version: '0.1.0' } }, claude!, claude!]),
    ).toBe('Kettu + 2 harnesses')
    expect(severalNote([claude!, claude!])).toBe('2 harnesses')
    expect(updateCardLabel({ kind: 'several', items: [claude!, claude!] })).toBe('2 updates')
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(updateCardLabel({ kind: 'waiting', item: claude! })).toBe('Claude Code 2.5.0 正在等待')
  })
})
