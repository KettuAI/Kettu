import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, DigestedToolEntry, SessionSnapshot, ThreadEntry } from '@shared/thread'

const hostMock = vi.fn()
const sessionHostMock = vi.fn<(sessionId: string) => string | null>(() => null)

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  sessionHost: (sessionId: string) => sessionHostMock(sessionId),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

function snapshot(id: string, entries: ThreadEntry[], seq = 1): SessionSnapshot {
  return {
    seq,
    older: null,
    plan: null,
    entries,
    session: {
      id,
      agentId: 'claude-code',
      projectPath: '/p',
      acpSessionId: null,
      status: 'ready',
      title: id,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 1,
      updatedAt: 1,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
  }
}

describe('threads store performance and digests', () => {
  const rafQueue: FrameRequestCallback[] = []

  beforeEach(() => {
    hostMock.mockReset()
    sessionHostMock.mockReset()
    sessionHostMock.mockReturnValue(null)
    rafQueue.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('loads a digested tool entry on demand, deduplicates calls, and preserves fresher status', async () => {
    const digested: DigestedToolEntry = {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'in_progress',
      content: [{ type: 'digest', of: 'diff', path: 'a.ts', size: 12000, added: 5, removed: 2 }],
      locations: [{ path: 'a.ts' }],
      permission: null,
      permissionResult: null,
      rawInputDigest: { size: 4000, lines: 80 },
    }
    const full: ThreadEntry = {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'old\n', newText: 'new\n' }],
      locations: [{ path: 'a.ts' }],
      permission: null,
      permissionResult: null,
      rawInput: 'full input',
    }

    let resolveEntry!: (value: ThreadEntry) => void
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') {
        return Promise.resolve(snapshot('s1', [digested as unknown as ThreadEntry], 1))
      }
      if (method === 'sessions.entry') {
        return new Promise<ThreadEntry>((resolve) => {
          resolveEntry = resolve
        })
      }
      return Promise.resolve()
    })

    const { focusSession, loadFullEntry, receiveBatch, useThreadsStore } = await import('./threads')
    await focusSession('s1')

    const first = loadFullEntry('s1', 't1')
    const second = loadFullEntry('s1', 't1')
    expect(hostMock.mock.calls.filter((c) => c[0] === 'sessions.entry')).toHaveLength(1)

    // A live patch marks the call completed while the full entry is in flight.
    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [{ op: 'entry.update', id: 't1', changes: { status: 'completed' } }],
    })
    for (const cb of rafQueue.splice(0)) cb(performance.now())

    resolveEntry(full)
    await Promise.all([first, second])

    const updated = useThreadsStore.getState().replicas.s1?.state?.byId.t1
    expect(updated?.kind).toBe('tool')
    if (updated?.kind === 'tool') {
      expect(updated.status).toBe('completed')
      expect(updated.rawInput).toBe('full input')
      expect(updated.content).toEqual(full.content)
    }

    // Calling again on an already-full entry issues no RPC (old-host and loaded compatibility).
    await loadFullEntry('s1', 't1')
    expect(hostMock.mock.calls.filter((c) => c[0] === 'sessions.entry')).toHaveLength(1)
  })

  it('drops queued patches on sequence gaps and triggers a snapshot resync', async () => {
    const snapCalls: unknown[] = []
    hostMock.mockImplementation((method: string, params: unknown) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', [], 1))
      if (method === 'sessions.snapshot') {
        snapCalls.push(params)
        return Promise.resolve(snapshot('s1', [], 10))
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch } = await import('./threads')
    await focusSession('s1')

    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [{ op: 'session.update', changes: { title: 'a' } }],
    })
    // Sequence gap before frame runs: drops queue and marks session for resync.
    receiveBatch({
      sessionId: 's1',
      seq: 5,
      patches: [{ op: 'session.update', changes: { title: 'b' } }],
    })
    receiveBatch({
      sessionId: 's1',
      seq: 9,
      patches: [{ op: 'session.update', changes: { title: 'c' } }],
    })

    for (const cb of rafQueue.splice(0)) cb(performance.now())
    await Promise.resolve()

    expect(snapCalls).toHaveLength(1)
  })

  it('keeps at most 1 recent unwatched session in the web client', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    hostMock.mockImplementation((method: string, params: { sessionId?: string }) => {
      if (method === 'sessions.open') return Promise.resolve(snapshot(params.sessionId ?? 's', []))
      return Promise.resolve()
    })

    const { focusSession, useThreadsStore } = await import('./threads')
    await focusSession('s1')
    await focusSession('s2')
    expect(Object.keys(useThreadsStore.getState().replicas)).toEqual(['s2'])
    expect(hostMock).toHaveBeenCalledWith('sessions.unwatch', { sessionId: 's1' })
  })

  it('invalidates cached outlines on forgetSession and rewatchAll', async () => {
    hostMock.mockImplementation((method: string, params: { sessionId?: string }) => {
      if (method === 'sessions.open' || method === 'sessions.snapshot') {
        return Promise.resolve(snapshot(params.sessionId ?? 's', []))
      }
      return Promise.resolve()
    })

    const { focusSession, forgetSession, rewatchAll } = await import('./threads')
    const { commitCachedOutline, getCachedOutline, invalidateOutlines } =
      await import('@renderer/features/session/outline/outline-cache')
    invalidateOutlines()

    await focusSession('s1')
    await focusSession('s2')
    commitCachedOutline('s1', [{ pos: 0, entryId: 'u1', text: 'one', title: null }])
    commitCachedOutline('s2', [{ pos: 0, entryId: 'u2', text: 'two', title: null }])

    forgetSession('s1')
    expect(getCachedOutline('s1')).toBeNull()
    expect(getCachedOutline('s2')).not.toBeNull()

    rewatchAll((id) => id === 's2')
    expect(getCachedOutline('s2')).toBeNull()
  })

  it('clears optimistic sending entries on normal, steered matching, and snapshot echoes (#2845)', async () => {
    const sent: ThreadEntry[] = []
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', sent, 1))
      if (method === 'sessions.snapshot') {
        return Promise.resolve(
          snapshot(
            's1',
            [
              {
                kind: 'user',
                id: 'e:snap',
                content: [{ type: 'text', text: 'Via snapshot' }],
                steered: true,
                at: Date.now(),
              },
            ],
            10,
          ),
        )
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch, rewatchAll, showSending, useThreadsStore } =
      await import('./threads')
    await focusSession('s1')

    // 1. Normal non-steered echo clears the optimistic sending entry with no duplicate.
    showSending('s1', [{ type: 'text', text: 'Follow up' }])
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['sending-1'])

    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [
        {
          op: 'entry.add',
          entry: { kind: 'user', id: 'e:1', content: [{ type: 'text', text: 'Follow up' }] },
        },
      ],
    })
    for (const cb of rafQueue.splice(0)) cb(performance.now())
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:1'])

    // 2. Defensive: even if a legacy host echoes the message with `steered: true`, matching text
    // clears `sending-N` instead of leaving it pinned at the bottom forever.
    showSending('s1', [{ type: 'text', text: 'Legacy steered echo' }])
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:1', 'sending-2'])

    // An unrelated steered message from another device must not prematurely clear the local send.
    receiveBatch({
      sessionId: 's1',
      seq: 3,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:other',
            content: [{ type: 'text', text: 'Other device steer' }],
            steered: true,
          },
        },
      ],
    })
    for (const cb of rafQueue.splice(0)) cb(performance.now())
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([
      'e:1',
      'e:other',
      'sending-2',
    ])

    // Once the matching steered echo arrives, `sending-2` is removed cleanly.
    receiveBatch({
      sessionId: 's1',
      seq: 4,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:2',
            content: [{ type: 'text', text: 'Legacy steered echo' }],
            steered: true,
          },
        },
      ],
    })
    for (const cb of rafQueue.splice(0)) cb(performance.now())
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:1', 'e:other', 'e:2'])

    // 3. Snapshot reconciliation also settles matching steered echoes.
    showSending('s1', [{ type: 'text', text: 'Via snapshot' }])
    rewatchAll()
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:snap']),
    )
  })

  it('settles web client device echoes across normal, steered, multi-send, interleaved batches, and snapshots (#2893)', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    const webDevice = { id: 'web-device-1', name: 'Chrome · Mac' }
    const otherDevice = { id: 'ios-device-2', name: 'iPhone' }
    let snapshotEntries: ThreadEntry[] = []
    let snapshotSeq = 20

    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', [], 1))
      if (method === 'sessions.snapshot') {
        return Promise.resolve(snapshot('s1', snapshotEntries, snapshotSeq))
      }
      return Promise.resolve()
    })

    const { useWebHostStore } = await import('./web-host')
    useWebHostStore.setState({
      host: {
        id: 'host-1',
        name: 'Mac Studio',
        platform: 'darwin',
        version: '0.1.30',
        address: null,
        connection: { state: 'online', relay: 'https://relay.kettu.sh' },
        lastOnlineAt: Date.now(),
        device: webDevice,
      },
    })

    const { focusSession, isFresh, receiveBatch, rewatchAll, showSending, useThreadsStore } =
      await import('./threads')
    await focusSession('s1')

    const flushRaf = () => {
      for (const cb of rafQueue.splice(0)) cb(performance.now())
    }

    // 1. Normal web echo carrying `device` clears `sending-1` without marking the echo fresh again.
    showSending('s1', [{ type: 'text', text: 'Hello from web' }])
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['sending-1'])

    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:1',
            content: [{ type: 'text', text: 'Hello from web' }],
            device: webDevice,
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:1'])
    expect(isFresh('s1', 'e:1')).toBe(false)

    // 2. Steered web echo carrying both `device` and `steered: true` clears `sending-2`.
    showSending('s1', [{ type: 'text', text: 'Steered from web' }])
    receiveBatch({
      sessionId: 's1',
      seq: 3,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:2',
            content: [{ type: 'text', text: 'Steered from web' }],
            device: webDevice,
            steered: true,
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:1', 'e:2'])

    // 3. Consecutive web messages A and B both settle cleanly with no stuck bubbles.
    showSending('s1', [{ type: 'text', text: 'Message A' }])
    showSending('s1', [{ type: 'text', text: 'Message B' }])
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([
      'e:1',
      'e:2',
      'sending-3',
      'sending-4',
    ])

    receiveBatch({
      sessionId: 's1',
      seq: 4,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:3',
            content: [{ type: 'text', text: 'Message A' }],
            device: webDevice,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:4',
            content: [{ type: 'text', text: 'Message B' }],
            device: webDevice,
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([
      'e:1',
      'e:2',
      'e:3',
      'e:4',
    ])

    // 4. Unrelated messages earlier in the same batch (local host window, another paired device
    // even with matching text, another tab on the same browser with different text, and an
    // agent-to-agent `from` entry) must neither clear `sending-5` nor cause an early break that
    // hides our real echo later in the batch.
    showSending('s1', [{ type: 'text', text: 'My web send' }])
    receiveBatch({
      sessionId: 's1',
      seq: 5,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:local-window',
            content: [{ type: 'text', text: 'My web send' }],
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:other-phone',
            content: [{ type: 'text', text: 'My web send' }],
            device: otherDevice,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:other-steered',
            content: [{ type: 'text', text: 'Steer from phone' }],
            device: otherDevice,
            steered: true,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:same-browser-other-tab',
            content: [{ type: 'text', text: 'Different tab text' }],
            device: webDevice,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:agent-session',
            content: [{ type: 'text', text: 'My web send' }],
            from: { sessionId: 'other-session', title: 'Helper' },
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:5',
            content: [{ type: 'text', text: 'My web send' }],
            device: webDevice,
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([
      'e:1',
      'e:2',
      'e:3',
      'e:4',
      'e:local-window',
      'e:other-phone',
      'e:other-steered',
      'e:same-browser-other-tab',
      'e:agent-session',
      'e:5',
    ])
    expect(isFresh('s1', 'e:other-phone')).toBe(true)
    expect(isFresh('s1', 'e:same-browser-other-tab')).toBe(true)
    expect(isFresh('s1', 'e:5')).toBe(false)

    // 5. Snapshot reconciliation settles web device echoes and rejects other-device matches.
    showSending('s1', [{ type: 'text', text: 'Reconnect send' }])
    snapshotEntries = [
      ...(useThreadsStore
        .getState()
        .replicas.s1!.state!.order.filter((id) => !id.startsWith('sending-'))
        .map((id) => useThreadsStore.getState().replicas.s1!.state!.byId[id]!) ?? []),
      {
        kind: 'user',
        id: 'e:other-snap',
        content: [{ type: 'text', text: 'Reconnect send' }],
        device: otherDevice,
        at: Date.now(),
      },
    ]
    rewatchAll()
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas.s1?.state?.order.at(-2)).toBe('e:other-snap'),
    )
    // Only the other device's entry arrived so far; our optimistic send remains waiting.
    expect(useThreadsStore.getState().replicas.s1?.state?.order.at(-1)).toBe('sending-6')

    snapshotSeq = 21
    snapshotEntries = [
      ...snapshotEntries,
      {
        kind: 'user',
        id: 'e:6',
        content: [{ type: 'text', text: 'Reconnect send' }],
        device: webDevice,
        at: Date.now(),
      },
    ]
    rewatchAll()
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas.s1?.state?.order.at(-1)).toBe('e:6'),
    )
    expect(
      useThreadsStore.getState().replicas.s1?.state?.order.some((id) => id.startsWith('sending-')),
    ).toBe(false)
  })

  it('settles empty-thread web snapshot echoes even when host clock lags behind browser clock (#2893)', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    const webDevice = { id: 'web-device-1', name: 'Chrome · Mac' }
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', [], 1))
      if (method === 'sessions.snapshot') {
        return Promise.resolve(
          snapshot(
            's1',
            [
              {
                kind: 'user',
                id: 'e:first',
                content: [{ type: 'text', text: 'First prompt' }],
                device: webDevice,
                // Simulate 60s clock skew where host clock is behind client clock.
                at: Date.now() - 60_000,
              },
            ],
            2,
          ),
        )
      }
      return Promise.resolve()
    })

    const { useWebHostStore } = await import('./web-host')
    useWebHostStore.setState({
      host: {
        id: 'host-1',
        name: 'Mac Studio',
        platform: 'darwin',
        version: '0.1.30',
        address: null,
        connection: { state: 'online', relay: 'https://relay.kettu.sh' },
        lastOnlineAt: Date.now(),
        device: webDevice,
      },
    })

    const { focusSession, rewatchAll, showSending, useThreadsStore } = await import('./threads')
    await focusSession('s1')

    showSending('s1', [{ type: 'text', text: 'First prompt' }])
    rewatchAll()
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:first']),
    )
  })

  it('settles remote desktop echoes and isolates concurrent sends from other devices or local windows (#2893)', async () => {
    sessionHostMock.mockImplementation((id) => (id === 'remote-s1' ? 'host-remote' : null))
    const remoteDesktop = { id: 'desk-1', name: 'MacBook Pro' }
    const otherPhone = { id: 'phone-1', name: 'iPhone' }

    hostMock.mockImplementation((method: string, params: { sessionId?: string }) => {
      const id = params?.sessionId ?? 'remote-s1'
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot(id, [], 1))
      if (method === 'sessions.snapshot') {
        return Promise.resolve(
          snapshot(
            id,
            [
              {
                kind: 'user',
                id: 'e:snap-remote',
                content: [{ type: 'text', text: 'Remote snap' }],
                device: remoteDesktop,
                at: Date.now(),
              },
            ],
            10,
          ),
        )
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch, rewatchAll, showSending, useThreadsStore } =
      await import('./threads')
    await focusSession('remote-s1')
    await focusSession('local-s1')

    const flushRaf = () => {
      for (const cb of rafQueue.splice(0)) cb(performance.now())
    }

    // Remote desktop session: host local window message (no device) and another device's different
    // message in the same batch must not prematurely clear or hide our real device echo.
    showSending('remote-s1', [{ type: 'text', text: 'From remote desktop' }])
    receiveBatch({
      sessionId: 'remote-s1',
      seq: 2,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:host-window',
            content: [{ type: 'text', text: 'From remote desktop' }],
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:phone-other',
            content: [{ type: 'text', text: 'Different phone message' }],
            device: otherPhone,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:remote-echo',
            content: [{ type: 'text', text: 'From remote desktop' }],
            device: remoteDesktop,
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas['remote-s1']?.state?.order).toEqual([
      'e:host-window',
      'e:phone-other',
      'e:remote-echo',
    ])

    // Snapshot reconciliation on a remote desktop session settles device-tagged echoes.
    showSending('remote-s1', [{ type: 'text', text: 'Remote snap' }])
    rewatchAll((id) => id === 'remote-s1')
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas['remote-s1']?.state?.order).toEqual([
        'e:snap-remote',
      ]),
    )

    // Local desktop session: paired-device or agent-to-agent messages with identical text must not
    // clear this window's optimistic bubble until the unmarked local window echo arrives.
    showSending('local-s1', [{ type: 'text', text: 'Same text' }])
    receiveBatch({
      sessionId: 'local-s1',
      seq: 2,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:paired',
            content: [{ type: 'text', text: 'Same text' }],
            device: otherPhone,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:from-session',
            content: [{ type: 'text', text: 'Same text' }],
            from: { sessionId: 'other', title: 'Worker' },
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas['local-s1']?.state?.order).toEqual([
      'e:paired',
      'e:from-session',
      'sending-3',
    ])

    receiveBatch({
      sessionId: 'local-s1',
      seq: 3,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:local-echo',
            content: [{ type: 'text', text: 'Same text' }],
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas['local-s1']?.state?.order).toEqual([
      'e:paired',
      'e:from-session',
      'e:local-echo',
    ])
  })

  it('matches attachment-only and image-only echoes by content fingerprint without false clears (#2893)', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    const webDevice = { id: 'web-device-1', name: 'Chrome · Mac' }
    const makeAttachment = (id: string, sent: Attachment['sent'] = null): Attachment => ({
      id,
      type: 'image',
      name: `${id}.png`,
      uri: null,
      mimeType: 'image/png',
      size: 1234,
      sent,
      thumb: null,
      blob: sent ? 'a'.repeat(64) : null,
    })

    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', [], 1))
      if (method === 'sessions.snapshot') {
        return Promise.resolve(
          snapshot(
            's1',
            [
              {
                kind: 'user',
                id: 'e:img-snap',
                content: [
                  {
                    type: 'ref',
                    ref: { kind: 'image', mimeType: 'image/png', blob: 'b'.repeat(64) },
                  },
                ],
                device: webDevice,
                at: Date.now(),
              },
            ],
            5,
          ),
        )
      }
      return Promise.resolve()
    })

    const { useWebHostStore } = await import('./web-host')
    useWebHostStore.setState({
      host: {
        id: 'host-1',
        name: 'Mac Studio',
        platform: 'darwin',
        version: '0.1.30',
        address: null,
        connection: { state: 'online', relay: 'https://relay.kettu.sh' },
        lastOnlineAt: Date.now(),
        device: webDevice,
      },
    })

    const { focusSession, receiveBatch, rewatchAll, showSending, useThreadsStore } =
      await import('./threads')
    await focusSession('s1')

    const flushRaf = () => {
      for (const cb of rafQueue.splice(0)) cb(performance.now())
    }

    // Two consecutive image-attachment-only sends (empty text).
    showSending('s1', [
      { type: 'ref', ref: { kind: 'attachment', attachment: makeAttachment('att-1') } },
    ])
    showSending('s1', [
      { type: 'ref', ref: { kind: 'attachment', attachment: makeAttachment('att-2') } },
    ])
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['sending-1', 'sending-2'])

    // Unrelated attachment-only message from same browser tab + settled echo for att-2 only.
    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:other-att',
            content: [
              {
                type: 'ref',
                ref: { kind: 'attachment', attachment: makeAttachment('att-other', 'image') },
              },
            ],
            device: webDevice,
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:att-2',
            content: [
              {
                type: 'ref',
                ref: { kind: 'attachment', attachment: makeAttachment('att-2', 'image') },
              },
            ],
            device: webDevice,
          },
        },
      ],
    })
    flushRaf()
    // Only `sending-2` (att-2) is settled; `sending-1` (att-1) remains intact.
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([
      'e:other-att',
      'e:att-2',
      'sending-1',
    ])

    // Echo for att-1 arrives next and clears `sending-1`.
    receiveBatch({
      sessionId: 's1',
      seq: 3,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:att-1',
            content: [
              {
                type: 'ref',
                ref: { kind: 'attachment', attachment: makeAttachment('att-1', 'image') },
              },
            ],
            device: webDevice,
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([
      'e:other-att',
      'e:att-2',
      'e:att-1',
    ])

    // Inline image ref sent optimistically also matches a blob-backed image ref on snapshot.
    showSending('s1', [
      { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: 'AAAA' } },
    ])
    rewatchAll()
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['e:img-snap']),
    )
  })

  it('reconciles pending sends cleanly across a thread.reset replay batch (#2893)', async () => {
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') {
        return Promise.resolve(
          snapshot(
            's1',
            [{ kind: 'user', id: 'e:old', content: [{ type: 'text', text: 'Ping' }] }],
            1,
          ),
        )
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch, showSending, useThreadsStore } = await import('./threads')
    await focusSession('s1')

    const flushRaf = () => {
      for (const cb of rafQueue.splice(0)) cb(performance.now())
    }

    showSending('s1', [{ type: 'text', text: 'Ping' }])

    // Replay resets the thread and re-emits the historical message without `at`; it must not clear
    // the new optimistic send.
    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [
        { op: 'thread.reset' },
        {
          op: 'entry.add',
          entry: { kind: 'user', id: 'm:old', content: [{ type: 'text', text: 'Ping' }] },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['m:old', 'sending-1'])

    // Once the live echo arrives, `sending-1` clears.
    receiveBatch({
      sessionId: 's1',
      seq: 3,
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'user',
            id: 'e:new',
            content: [{ type: 'text', text: 'Ping' }],
            at: Date.now(),
          },
        },
      ],
    })
    flushRaf()
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual(['m:old', 'e:new'])
  })
})
