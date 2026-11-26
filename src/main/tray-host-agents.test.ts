import { describe, expect, it, vi } from 'vitest'
import type { PlanLimit } from '@shared/agent-host'
import type { TrayHostAgents } from '@shared/tray'
import { toTrayHostAgent, TrayHostAgentsFeed } from './tray-host-agents'

function limit(usedPercent: number, observedAt: number): PlanLimit {
  return {
    window: 'five_hour',
    label: '5-hour',
    usedPercent,
    resetsAt: observedAt + 3_600_000,
    state: usedPercent >= 100 ? 'reached' : usedPercent >= 80 ? 'warning' : 'ok',
    observedAt,
  }
}

function rawAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    harnessId: 'claude-code',
    harnessName: 'Claude Code',
    isDefault: true,
    hidden: false,
    state: 'ready',
    binaryPath: '/secret/path/claude',
    launchCommand: 'claude --secret',
    account: {
      kind: 'account',
      label: 'Claude Max',
      email: 'alice@example.com',
      tier: '5x',
      signInEnds: 9_999_999,
    },
    limits: [limit(60, 200)],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('toTrayHostAgent', () => {
  it('keeps only the minimal fields required for account matching and plan limits', () => {
    const parsed = toTrayHostAgent(rawAgent())
    expect(parsed).toEqual({
      id: 'claude-code',
      harnessId: 'claude-code',
      account: {
        kind: 'account',
        label: 'Claude Max',
        email: 'alice@example.com',
        tier: '5x',
      },
      limits: [limit(60, 200)],
    })
    expect(Object.keys(parsed!)).toEqual(['id', 'harnessId', 'account', 'limits'])
  })

  it('drops malformed remote payloads and invalid limit entries', () => {
    expect(toTrayHostAgent(null)).toBeNull()
    expect(toTrayHostAgent({ id: '../evil', harnessId: 'claude-code', limits: [] })).toBeNull()
    expect(toTrayHostAgent({ id: 'claude-code', harnessId: 'unknown', limits: [] })).toBeNull()
    expect(
      toTrayHostAgent({ id: 'claude-code', harnessId: 'claude-code', limits: 'bad' }),
    ).toBeNull()

    const partial = toTrayHostAgent(
      rawAgent({
        account: { kind: 'invalid', label: 'X', email: 'a@b.com' },
        limits: [{ bad: true }, limit(45, 300)],
      }),
    )
    expect(partial?.account).toBeNull()
    expect(partial?.limits).toEqual([limit(45, 300)])
  })
})

describe('TrayHostAgentsFeed', () => {
  it('stays inactive until snapshot() is requested, then loads open hosts lazily', async () => {
    const open = new Set(['host-a'])
    const listAgents = vi.fn(async () => [rawAgent()])
    const changed = vi.fn<(hosts: TrayHostAgents[]) => void>()
    const feed = new TrayHostAgentsFeed({
      openHosts: () => [...open],
      listAgents,
      changed,
      warn: vi.fn(),
    })

    // Events before activation do not query remote hosts.
    feed.opened('host-a')
    feed.event('host-a', { type: 'agent.status', status: rawAgent({ limits: [limit(70, 300)] }) })
    expect(listAgents).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()

    // First snapshot returns immediately without blocking and triggers async read.
    expect(feed.snapshot()).toEqual([])
    expect(listAgents).toHaveBeenCalledTimes(1)
    expect(listAgents).toHaveBeenCalledWith('host-a')

    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenLastCalledWith([
      {
        hostId: 'host-a',
        agents: [toTrayHostAgent(rawAgent())],
      },
    ])
  })

  it('applies live agent.status and agent.removed updates and suppresses no-op pushes', async () => {
    const listAgents = vi.fn(async () => [rawAgent({ limits: [limit(30, 100)] })])
    const changed = vi.fn<(hosts: TrayHostAgents[]) => void>()
    const feed = new TrayHostAgentsFeed({
      openHosts: () => ['host-a'],
      listAgents,
      changed,
      warn: vi.fn(),
    })

    feed.snapshot()
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)

    // Changing only non-limit metadata (like progress/version) does not trigger a push.
    feed.event('host-a', {
      type: 'agent.status',
      status: rawAgent({ limits: [limit(30, 100)], version: '2.0.0', progress: ['loading'] }),
    })
    expect(changed).toHaveBeenCalledTimes(1)

    // Newer plan limits push immediately.
    feed.event('host-a', {
      type: 'agent.status',
      status: rawAgent({ limits: [limit(82, 400)] }),
    })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1]![0][0]!.agents[0]!.limits[0]!.usedPercent).toBe(82)

    // Unrelated host events are ignored.
    feed.event('host-a', { type: 'session.summary', summary: { id: 's1' } })
    expect(changed).toHaveBeenCalledTimes(2)

    // Removing the agent drops it from the snapshot.
    feed.event('host-a', { type: 'agent.removed', agentId: 'claude-code' })
    expect(changed).toHaveBeenCalledTimes(3)
    expect(changed).toHaveBeenLastCalledWith([])
  })

  it('replays live updates that arrive while agents.list is in flight', async () => {
    const list = deferred<unknown[]>()
    const changed = vi.fn<(hosts: TrayHostAgents[]) => void>()
    const feed = new TrayHostAgentsFeed({
      openHosts: () => ['host-a'],
      listAgents: () => list.promise,
      changed,
      warn: vi.fn(),
    })

    feed.snapshot()
    // Newer status arrives before the initial agents.list response completes.
    feed.event('host-a', {
      type: 'agent.status',
      status: rawAgent({ limits: [limit(90, 500)] }),
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![0][0]!.agents[0]!.limits[0]!.usedPercent).toBe(90)

    // Older agents.list response resolves and must not clobber the newer live update.
    list.resolve([
      rawAgent({ limits: [limit(20, 100)] }),
      rawAgent({ id: 'codex', harnessId: 'codex', limits: [limit(15, 100)] }),
    ])
    await flush()
    expect(changed).toHaveBeenCalledTimes(2)
    const agents = changed.mock.calls[1]![0][0]!.agents
    expect(agents.find((a) => a.id === 'claude-code')?.limits[0]?.usedPercent).toBe(90)
    expect(agents.find((a) => a.id === 'codex')?.limits[0]?.usedPercent).toBe(15)
  })

  it('drops host data on ended() or syncHosts() and ignores stale in-flight loads', async () => {
    const listA = deferred<unknown[]>()
    const open = new Set(['host-a', 'host-b'])
    const changed = vi.fn<(hosts: TrayHostAgents[]) => void>()
    const feed = new TrayHostAgentsFeed({
      openHosts: () => [...open],
      listAgents: (hostId) =>
        hostId === 'host-a'
          ? listA.promise
          : Promise.resolve([rawAgent({ limits: [limit(55, 250)] })]),
      changed,
      warn: vi.fn(),
    })

    feed.snapshot()
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![0].map((h) => h.hostId)).toEqual(['host-b'])

    // host-a disconnects before its list finishes; resolving later must be ignored.
    open.delete('host-a')
    feed.ended('host-a')
    listA.resolve([rawAgent({ limits: [limit(99, 999)] })])
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)

    // Removing host-b via syncHosts drops it and notifies the panel.
    open.delete('host-b')
    feed.syncHosts([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith([])
  })

  it('re-reads on resync(), retries failed loads on ensureLoaded(), and resets on deactivate()', async () => {
    let calls = 0
    const open = new Set(['host-a'])
    const warn = vi.fn()
    const changed = vi.fn<(hosts: TrayHostAgents[]) => void>()
    const feed = new TrayHostAgentsFeed({
      openHosts: () => [...open],
      listAgents: async () => {
        calls++
        if (calls === 1) throw new Error('temporary network drop')
        return [rawAgent({ limits: [limit(calls * 10, calls * 100)] })]
      },
      changed,
      warn,
    })

    feed.snapshot()
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()

    // Retrying on next panel open succeeds.
    feed.ensureLoaded()
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![0][0]!.agents[0]!.limits[0]!.usedPercent).toBe(20)

    // Resync reloads the host.
    feed.resync('host-a')
    await flush()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1]![0][0]!.agents[0]!.limits[0]!.usedPercent).toBe(30)

    // Deactivating clears cached data and ignores subsequent events until re-activated.
    feed.deactivate()
    feed.event('host-a', { type: 'agent.status', status: rawAgent({ limits: [limit(95, 900)] }) })
    expect(changed).toHaveBeenCalledTimes(2)

    expect(feed.snapshot()).toEqual([])
    await flush()
    expect(changed).toHaveBeenCalledTimes(3)
    expect(changed.mock.calls[2]![0][0]!.agents[0]!.limits[0]!.usedPercent).toBe(40)
  })
})
