// Integration tests: the session layer, through the host and its port, against the fake agent
// running in-process.

import { afterEach, describe, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  current = await startTestHost(options)
  const port = current.connect()
  return { t: current, port }
}

async function newSession(t: TestHost, port: TestPort) {
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: t.project,
  })
  await port.open(summary.id)
  return summary.id
}

async function turn(port: TestPort, sessionId: string, text: string) {
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
}

function tools(port: TestPort, sessionId: string): ToolEntry[] {
  return port.entries(sessionId).filter((entry): entry is ToolEntry => entry.kind === 'tool')
}

describe('a prompt turn', () => {
  it('streams a whole turn into the watching port', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    expect(port.summary(sessionId)).toMatchObject({ status: 'ready', origin: 'user' })

    await turn(port, sessionId, 'Fix the flaky login test')
    expect(port.summary(sessionId)?.status).toBe('running')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    await port.untilStatus(sessionId, 'ready')

    const entries = port.entries(sessionId)
    expect(entries[0]).toEqual({
      kind: 'user',
      id: 'e:1',
      content: [{ type: 'text', text: 'Fix the flaky login test' }],
    })
    const agent = entries.find((entry) => entry.kind === 'agent')
    expect(agent).toMatchObject({ streaming: false })
    expect(agent?.id.startsWith('m:')).toBe(true)
    expect(tools(port, sessionId).some((tool) => tool.content.some((c) => c.type === 'diff'))).toBe(
      true,
    )
    const end = entries.at(-1)
    expect(end).toMatchObject({ kind: 'turn_end', stopReason: 'end_turn' })
    expect(end?.kind === 'turn_end' && end.durationMs).toBeGreaterThanOrEqual(0)

    const session = port.thread(sessionId).session
    expect(session.title).toBe('Fix the flaky login test')
    expect(session.usage?.tokens?.total).toBeGreaterThan(0)
    expect(session.usage?.size).toBe(200_000)
    expect(session.config.map((option) => option.id)).toEqual([
      'mode',
      'model',
      'thought_level',
      'fast',
    ])
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', sessionId, kind: 'turn-ended' }),
    )
  })

  it('puts the account and plan limits on the agent status', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    const [status] = await port
      .request('agents.check', { agentId: 'fake-agent' })
      .then((all) => all.filter((s) => s.id === 'fake-agent'))
    expect(status).toMatchObject({
      state: 'ready',
      version: '0.1.0',
      signIn: 'signed-in',
      account: { kind: 'account', label: 'Fake Pro', email: 'developer@example.com' },
    })
    const windows = Object.fromEntries(status!.limits.map((limit) => [limit.window, limit]))
    // The fake agent reports 0.12 + 0.07 per turn, as a fraction like Claude Code does.
    expect(windows.five_hour).toMatchObject({ label: '5-hour', usedPercent: 19, state: 'ok' })
    expect(windows.seven_day).toMatchObject({ label: 'Weekly', usedPercent: 32 })
    expect(windows.five_hour!.resetsAt).toBeGreaterThan(Date.now())
  })

  it('rejects a prompt while a turn runs, and on a session that is not open', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' } })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await expect(turn(port, sessionId, 'again')).rejects.toMatchObject({ code: 'busy' })
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    await expect(
      port.request('sessions.prompt', {
        sessionId: 'no-such-session',
        content: [{ type: 'text', text: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('permissions', () => {
  it.each([
    ['allow-once', 'allow_once'],
    ['allow-always', 'allow_always'],
    ['reject-once', 'reject_once'],
    ['reject-always', 'reject_always'],
  ] as const)('answers with %s', async (optionId, kind) => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/permission')
    await port.untilStatus(sessionId, 'awaiting_permission')
    expect(port.summary(sessionId)).toMatchObject({ attention: 'permission', permissionCount: 1 })
    expect(t.sent).toContainEqual({ type: 'host:badge', count: 1 })
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', sessionId, kind: 'permission' }),
    )
    await port.until(() => tools(port, sessionId).some((tool) => tool.permission !== null))
    const tool = tools(port, sessionId).find((entry) => entry.permission)!
    expect(tool.permission!.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ])
    const { requestId } = tool.permission!

    await expect(
      port.request('permissions.respond', { sessionId, requestId, optionId: 'maybe' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      port.request('permissions.respond', { sessionId, requestId: 'p999', optionId }),
    ).rejects.toMatchObject({ code: 'not_found' })
    // A failed answer changes nothing.
    expect(port.summary(sessionId)?.permissionCount).toBe(1)

    await port.request('permissions.respond', { sessionId, requestId, optionId })
    await port.untilStatus(sessionId, 'ready')
    const answered = tools(port, sessionId).find((entry) => entry.id === tool.id)!
    expect(answered.permission).toBeNull()
    expect(answered.permissionResult).toEqual({ optionId, kind })
    expect(t.sent.filter((m) => m.type === 'host:badge').at(-1)).toEqual({
      type: 'host:badge',
      count: 0,
    })
    const reply = port.entries(sessionId).filter((entry) => entry.kind === 'agent')
    expect(reply.at(-1)?.kind === 'agent' && reply.at(-1)?.markdown).toContain(optionId)
  })

  it('keeps several requests pending at once', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/parallel-permissions')
    await port.until(() => port.summary(sessionId)?.permissionCount === 3)
    expect(t.sent).toContainEqual({ type: 'host:badge', count: 3 })
    const pending = tools(port, sessionId).filter((tool) => tool.permission)
    expect(pending).toHaveLength(3)
    for (const [index, tool] of [...pending].reverse().entries()) {
      await port.request('permissions.respond', {
        sessionId,
        requestId: tool.permission!.requestId,
        optionId: 'allow-once',
      })
      if (index < 2) expect(port.summary(sessionId)?.status).toBe('awaiting_permission')
    }
    await port.untilStatus(sessionId, 'ready')
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
    expect(tools(port, sessionId).filter((tool) => tool.permissionResult)).toHaveLength(3)
  })

  it('clears a request the agent withdraws', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/permission --withdraw 1')
    await port.untilStatus(sessionId, 'ready')
    const tool = tools(port, sessionId).find((entry) => entry.permissionResult)!
    expect(tool.permissionResult).toBe('withdrawn')
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
  })
})

describe('cancellation', () => {
  it('ends the turn when the agent confirms', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' } })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'agent')
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).at(-1)).toMatchObject({
      kind: 'turn_end',
      stopReason: 'cancelled',
    })
    expect(port.entries(sessionId).some((entry) => entry.kind === 'notice')).toBe(false)
  })

  it('answers pending requests cancelled at once', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/parallel-permissions')
    await port.until(() => port.summary(sessionId)?.permissionCount === 3)
    await port.request('sessions.cancel', { sessionId })
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
    await port.untilStatus(sessionId, 'ready')
    const results = tools(port, sessionId).flatMap((tool) =>
      tool.permissionResult ? [tool.permissionResult] : [],
    )
    expect(results).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(port.entries(sessionId).at(-1)).toMatchObject({ stopReason: 'cancelled' })
  })

  it('ends the turn itself when the agent never confirms', async () => {
    const { t, port } = await setup({
      agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' },
      sessionTimings: { cancelFallbackMs: 200 },
    })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel --ignore-cancel')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'agent')
    const started = Date.now()
    await port.request('sessions.cancel', { sessionId })
    expect(port.summary(sessionId)?.status).toBe('running')
    await port.untilStatus(sessionId, 'ready')
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    const entries = port.entries(sessionId)
    const notice = entries.find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'warning' })
    expect(entries.findLast((entry) => entry.kind === 'turn_end')).toMatchObject({
      stopReason: 'cancelled',
    })
  })
})

describe('opening and recovering', () => {
  it('replays the history with session/load after a close', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilStatus(sessionId, 'ready')
    const before = port.entries(sessionId)

    await port.request('sessions.close', { sessionId })
    expect(port.summary(sessionId)).toMatchObject({ status: 'closed' })
    const closed = await port.request('sessions.snapshot', { sessionId })
    expect(closed).toMatchObject({ session: { status: 'closed' }, entries: [] })
    const seqBefore = port.replicas.get(sessionId)!.seq

    const patchesFrom = port.events.length
    const snapshot = await port.request('sessions.open', { sessionId })
    expect(snapshot.session.status).toBe('ready')
    expect(snapshot.seq).toBeGreaterThan(seqBefore)
    const batches = port.events
      .slice(patchesFrom)
      .flatMap((event) => (event.type === 'session.patches' ? [event.batch] : []))
    const ops = batches.flatMap((batch) => batch.patches.map((patch) => patch.op))
    expect(ops).toContain('thread.reset')
    expect(ops.indexOf('thread.reset')).toBeLessThan(ops.indexOf('entry.add'))
    // The renderer's replica, patched through the replay, ends where the snapshot is.
    expect(port.entries(sessionId)).toEqual(snapshot.entries)
    expect(port.replicas.get(sessionId)!.seq).toBe(snapshot.seq)

    const kinds = (entries: typeof before) =>
      entries.filter((e) => e.kind === 'user' || e.kind === 'agent' || e.kind === 'tool').length
    expect(kinds(snapshot.entries)).toBe(kinds(before))
    expect(snapshot.entries.find((entry) => entry.kind === 'user')).toMatchObject({
      content: [{ type: 'text', text: 'Fix the flaky login test' }],
    })
    expect(snapshot.entries.every((e) => !('streaming' in e) || e.streaming === false)).toBe(true)
  })

  it('reconnects with session/resume after the agent crashes', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    await turn(port, sessionId, '/crash --code 9')
    await port.untilStatus(sessionId, 'disconnected')
    const notice = port.entries(sessionId).find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'error' })
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', sessionId, kind: 'error' }),
    )
    // The agent restarts on its own and the session comes back with its thread.
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).some((entry) => entry.kind === 'user')).toBe(true)
    const agentEvents = t.host.diagnostics.agentRecords('fake-agent').events.map((e) => e.event)
    expect(agentEvents).toEqual(expect.arrayContaining(['exit', 'restart scheduled', 'ready']))
    expect(t.launcher).toMatchObject({ launches: 2 })
    await turn(port, sessionId, 'still there?')
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).at(-1)).toMatchObject({ stopReason: 'end_turn' })
  })

  it('opens a session from the index after a restart of the host', async () => {
    const first = await startTestHost()
    let port = first.connect()
    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: first.project,
    })
    // Not watched: the turn's end leaves it unread.
    await port.request('sessions.prompt', {
      sessionId: created.id,
      content: [{ type: 'text', text: 'Fix it' }],
    })
    await port.untilStatus(created.id, 'ready')
    expect(port.summary(created.id)).toMatchObject({ attention: 'unread' })
    await first.host.shutdown()
    expect(first.sent.at(-1)).toEqual({ type: 'host:stopped' })

    current = await startTestHost({ userDataPath: first.dir })
    port = current.connect()
    const [summary] = await port.request('sessions.list', {})
    expect(summary).toMatchObject({
      id: created.id,
      status: 'closed',
      title: 'Fix it',
      attention: 'unread',
    })
    const snapshot = await port.open(created.id)
    // A new fake agent process does not know the session and synthesizes a short history.
    expect(snapshot.session.status).toBe('ready')
    expect(snapshot.entries.length).toBeGreaterThan(0)
    expect(port.summary(created.id)).toMatchObject({ attention: 'none' })
  })
})

describe('sign-in', () => {
  it('waits in auth_required and continues after authenticate', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_AUTH: 'required' } })
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(summary.status).toBe('auth_required')
    const [status] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(status).toMatchObject({ signIn: 'required' })
    expect(status!.authMethods.map((method) => method.type)).toEqual(['agent', 'terminal'])
    const terminal = status!.authMethods.find((method) => method.type === 'terminal')!
    expect(terminal.command).toContain('--login')
    expect(t.sent).toContainEqual({ type: 'host:auth-commands', commands: [terminal.command] })

    await port.request('agents.authenticate', { agentId: 'fake-agent', methodId: 'fake-login' })
    await port.untilStatus(summary.id, 'ready')
    const [after] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(after).toMatchObject({ signIn: 'signed-in' })
    // Once session/new succeeded, the session is in the index.
    await port.request('sessions.close', { sessionId: summary.id })
    expect(port.summary(summary.id)).toMatchObject({ status: 'closed' })
  })

  it('turns a prompt that needs sign-in into auth_required', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/auth-required')
    await port.untilStatus(sessionId, 'auth_required')
    const notice = port.entries(sessionId).find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'error' })
    const [status] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(status).toMatchObject({ signIn: 'required', account: { kind: 'none' } })
    await expect(
      port.request('agents.authenticate', { agentId: 'fake-agent', methodId: 'nope' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('updates', () => {
  it('maps every variant and records the unknown one', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/all-updates')
    await port.untilStatus(sessionId, 'ready')
    const kinds = new Set(port.entries(sessionId).map((entry) => entry.kind))
    for (const kind of ['user', 'agent', 'thought', 'tool', 'plan', 'notice', 'compaction']) {
      expect(kinds).toContain(kind)
    }
    const session = port.thread(sessionId).session
    expect(session.commands.length).toBeGreaterThan(0)
    const bundle = await port.request('diagnostics.collect', undefined)
    const fake = bundle.agents.find((agent) => agent.status.id === 'fake-agent')!
    expect(
      fake.events.some((e) => e.event === 'ignored' && e.detail?.includes('future_update')),
    ).toBe(true)
    expect(fake.traffic.length).toBeGreaterThan(0)
    expect(Object.keys(bundle.environment)).toEqual(['PATH', 'SHELL', 'node'])
  })
})

describe('sub-sessions', () => {
  async function runSubagent(t: TestHost, port: TestPort) {
    const parentId = await newSession(t, port)
    await turn(port, parentId, '/subagent')
    await port.until(() =>
      port.events.some((e) => e.type === 'session.summary' && e.summary.parentId === parentId),
    )
    const child = port.events.flatMap((e) =>
      e.type === 'session.summary' && e.summary.parentId === parentId ? [e.summary] : [],
    )[0]!
    return { parentId, childId: child.id }
  }

  it('creates the child, and its permission request reaches the child', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    expect(port.summary(childId)).toMatchObject({
      origin: 'subagent',
      parentId,
      description: 'Find where the session token is issued and validated',
      title: 'Explore the repository',
    })
    await port.open(childId)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    expect(port.summary(parentId)?.permissionCount).toBe(0)
    expect(port.summary(childId)?.status).toBe('awaiting_permission')
    await port.untilEntry(parentId, (entry) => entry.kind === 'subagent')
    expect(port.entries(parentId)).toContainEqual({
      kind: 'subagent',
      id: `s:${childId}`,
      sessionId: childId,
    })

    const childEntries = port.entries(childId)
    expect(childEntries[0]).toMatchObject({ kind: 'session_message', senderId: parentId })
    const tool = tools(port, childId).find((entry) => entry.permission)!
    await expect(
      port.request('sessions.prompt', {
        sessionId: childId,
        content: [{ type: 'text', text: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'restricted' })
    await expect(port.request('sessions.close', { sessionId: childId })).rejects.toMatchObject({
      code: 'restricted',
    })

    await port.request('permissions.respond', {
      sessionId: childId,
      requestId: tool.permission!.requestId,
      optionId: 'allow-once',
    })
    await port.untilStatus(parentId, 'ready')
    expect(port.summary(childId)).toMatchObject({ status: 'ready', permissionCount: 0 })
    expect(port.thread(childId).session.subagent).toMatchObject({
      canCancel: true,
      stateKnown: true,
      stopReason: 'end_turn',
    })
    expect(port.thread(childId).session.usage?.tokens?.input).toBe(4800)
    expect(port.entries(childId).at(-1)).toMatchObject({ kind: 'turn_end', stopReason: 'end_turn' })
  })

  it('cancels a child that allows it', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    await port.request('sessions.cancel', { sessionId: childId })
    await port.untilStatus(parentId, 'ready')
    expect(port.summary(childId)).toMatchObject({ permissionCount: 0 })
  })

  it('cascades delete to sub-sessions of either origin', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    const user = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
      parentId,
    })
    expect(user).toMatchObject({ parentId, origin: 'user', status: 'ready' })
    await expect(port.request('sessions.delete', { sessionId: childId })).rejects.toMatchObject({
      code: 'restricted',
    })

    await port.request('sessions.delete', { sessionId: parentId })
    const removed = port.events.flatMap((e) => (e.type === 'session.removed' ? [e.sessionId] : []))
    expect(removed).toEqual(expect.arrayContaining([parentId, childId, user.id]))
    expect(await port.request('sessions.list', {})).toEqual([])
    expect(t.sent.filter((m) => m.type === 'host:badge').at(-1)).toEqual({
      type: 'host:badge',
      count: 0,
    })
  })

  it('keeps a user sub-session in its parent project', async () => {
    const { t, port } = await setup()
    const parentId = await newSession(t, port)
    await expect(
      port.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: t.dir,
        parentId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('config options', () => {
  it('sets an option and takes the agent config back', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'model', value: 'deep' })
    await port.until(
      () => port.thread(sessionId).session.config.find((o) => o.id === 'model')?.value === 'deep',
    )
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'fast', value: true })
    await expect(
      port.request('sessions.setConfigOption', { sessionId, optionId: 'model', value: 'huge' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      port.request('sessions.setConfigOption', { sessionId, optionId: 'fast', value: 'yes' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    const model = port.thread(sessionId).session.config.find((o) => o.id === 'model')!
    expect(model.choices?.map((c) => c.group)).toEqual(['Fast', 'Smart', 'Smart'])
  })

  it('offers legacy modes as the synthetic __mode option', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' } })
    const sessionId = await newSession(t, port)
    const mode = () => port.thread(sessionId).session.config.find((o) => o.id === '__mode')
    expect(mode()).toMatchObject({ category: 'mode', type: 'select', value: 'ask' })
    await port.request('sessions.setConfigOption', { sessionId, optionId: '__mode', value: 'code' })
    await port.until(() => mode()?.value === 'code')
  })
})

describe('streaming', () => {
  it('coalesces chunks into batches with consecutive seq numbers', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    const startSeq = port.replicas.get(sessionId)!.seq
    await turn(port, sessionId, '/long-stream --size 40k --rate 100000')
    await port.untilStatus(sessionId, 'ready')
    const batches = port.events.flatMap((e) =>
      e.type === 'session.patches' && e.batch.sessionId === sessionId ? [e.batch] : [],
    )
    // TestPort throws on a gap, so every batch was exactly one after the last.
    expect(batches.map((b) => b.seq)).toEqual(batches.map((_, i) => startSeq + i + 1))
    const appends = batches.flatMap((b) => b.patches.filter((p) => p.op === 'entry.appendText'))
    // 40 KB in 100-character chunks is about 400 updates, merged into far fewer patches.
    expect(appends.length).toBeLessThan(200)
    for (const batch of batches) {
      batch.patches.forEach((patch, i) => {
        const next = batch.patches[i + 1]
        if (patch.op === 'entry.appendText' && next?.op === 'entry.appendText') {
          expect(next.id).not.toBe(patch.id)
        }
      })
    }
    const reply = port.entries(sessionId).find((entry) => entry.kind === 'agent')
    expect(reply?.kind === 'agent' && reply.markdown.length).toBeGreaterThanOrEqual(40 * 1024)
    const snapshot = await port.request('sessions.snapshot', { sessionId })
    expect(snapshot.entries).toEqual(port.entries(sessionId))
  })

  it('sends a session patches before its summary', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    const events = port.events
    const isSummary = (i: number, status: string) => {
      const e = events[i]!
      return (
        e.type === 'session.summary' && e.summary.id === sessionId && e.summary.status === status
      )
    }
    const running = events.findIndex((_, i) => isSummary(i, 'running'))
    const ready = events.findIndex((_, i) => i > running && isSummary(i, 'ready'))
    const turnEnd = events.findIndex(
      (e) =>
        e.type === 'session.patches' &&
        e.batch.sessionId === sessionId &&
        e.batch.patches.some((p) => p.op === 'entry.add' && p.entry.kind === 'turn_end'),
    )
    expect(running).toBeGreaterThanOrEqual(0)
    expect(turnEnd).toBeGreaterThan(running)
    expect(turnEnd).toBeLessThan(ready)
  })

  it('streams only to ports that watch the session', async () => {
    const { t, port } = await setup()
    const other = t.connect()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    await other.untilStatus(sessionId, 'ready')
    expect(other.events.some((e) => e.type === 'session.patches')).toBe(false)
    expect(other.events.some((e) => e.type === 'session.summary')).toBe(true)
  })
})

describe('unread and viewing', () => {
  it('marks a turn that ends unwatched as unread, and watching clears it', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await port.request('sessions.unwatch', { sessionId })
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    expect(port.summary(sessionId)?.attention).toBe('unread')
    await port.request('sessions.watch', { sessionId })
    expect(port.summary(sessionId)?.attention).toBe('none')
  })

  it('drops the watches of a port that closes', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    port.disconnect()
    const other = t.connect()
    await other.request('sessions.prompt', { sessionId, content: [{ type: 'text', text: 'hi' }] })
    await other.untilStatus(sessionId, 'ready')
    expect(other.summary(sessionId)?.attention).toBe('unread')
  })
})

describe('the index', () => {
  it('imports a session the agent lists, following nextCursor', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_LIST_PAGE: '1' } })
    const first = await port.request('agents.listSessions', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(first.sessions).toHaveLength(1)
    expect(first.nextCursor).toBe('1')
    const second = await port.request('agents.listSessions', {
      agentId: 'fake-agent',
      projectPath: t.project,
      cursor: first.nextCursor!,
    })
    const all = [...first.sessions, ...second.sessions]
    const cli = all.find((s) => s.acpSessionId === 'cli-refactor-router')!
    expect(cli).toMatchObject({ imported: false, title: 'Started in the CLI: refactor the router' })

    const imported = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    expect(imported).toMatchObject({ status: 'closed', title: cli.title, origin: 'user' })
    const again = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    expect(again.id).toBe(imported.id)
    const relisted = await port.request('agents.listSessions', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(relisted.sessions[0]).toMatchObject({ imported: true })
    const snapshot = await port.open(imported.id)
    expect(snapshot.session.status).toBe('ready')
  })

  it('removes everything from the index, keeping nothing live', async () => {
    const { t, port } = await setup()
    const a = await newSession(t, port)
    await newSession(t, port)
    await turn(port, a, '/permission')
    await port.until(() => port.summary(a)?.permissionCount === 1)
    await port.request('sessions.removeAll', undefined)
    expect(await port.request('sessions.list', {})).toEqual([])
    expect(t.host.sessions.busy()).toEqual([])
  })

  it('names a session after its first message until the agent sends a title', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    const long = `${'word '.repeat(30)}\nsecond line`
    await port.request('sessions.prompt', {
      sessionId,
      content: [{ type: 'text', text: `/scenario cancel ${long}` }],
    })
    const title =
      port.events.flatMap((e) =>
        e.type === 'session.summary' && e.summary.id === sessionId && e.summary.title
          ? [e.summary.title]
          : [],
      )[0] ?? ''
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.startsWith('/scenario cancel word')).toBe(true)
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
  })
})
