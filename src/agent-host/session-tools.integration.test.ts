// Integration tests: the session tools as sessions attach, work and go, called over HTTP with a
// session's own token, against the fake agent running in-process.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

interface Reply {
  result?: CallToolResult
  error?: { code: number; message: string }
}

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  current = await startTestHost(options)
  const t = current
  const port = t.connect()
  // Every attach's servers, as the host handed them to the agent.
  const attached: { sessionId: string; servers: McpServer[] }[] = []
  const service = t.host.artifactService
  const servers = service.servers.bind(service)
  vi.spyOn(service, 'servers').mockImplementation((sessionId, project) => {
    const given = servers(sessionId, project)
    attached.push({ sessionId, servers: given })
    return given
  })
  const folderServers = service.folderServers.bind(service)
  vi.spyOn(service, 'folderServers').mockImplementation((process, folder, sessionId) => {
    const given = folderServers(process, folder, sessionId)
    attached.push({ sessionId, servers: given })
    return given
  })
  const token = (sessionId: string): string => {
    const server = attached.filter((a) => a.sessionId === sessionId).at(-1)?.servers[0]
    if (!server || !('headers' in server)) throw new Error(`No token for ${sessionId}`)
    const header = (server.headers as { name: string; value: string }[]).find(
      (h) => h.name === 'Authorization',
    )
    return header!.value
  }
  const call = async (
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<Reply> => {
    const response = await fetch(service.url!, {
      method: 'POST',
      headers: {
        Authorization: token(sessionId),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      }),
    })
    return (await response.json()) as Reply
  }
  const create = async (projectPath = t.project) => {
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath,
    })
    await port.open(summary.id)
    return summary.id
  }
  /** Sends a prompt through the port and waits for its turn to end. */
  const run = async (sessionId: string, text: string) => {
    const before = turns(port, sessionId)
    await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
    await port.until(() => turns(port, sessionId) > before)
  }
  return { t, port, attached, service, call, create, run, token }
}

function turns(port: TestPort, sessionId: string): number {
  return port.replicas.has(sessionId)
    ? port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
    : 0
}

function structured(reply: Reply): Record<string, unknown> {
  expect(reply.error).toBeUndefined()
  return reply.result!.structuredContent as Record<string, unknown>
}

function code(reply: Reply): string {
  expect(reply.result?.isError).toBe(true)
  return (reply.result!.structuredContent as { code: string }).code
}

describe('the session tools', () => {
  it("lists the project's sessions, reads a closed one and renames itself", async () => {
    const { t, port, call, create, run } = await setup()
    const a = await create()
    await run(a, 'Caller session')
    const b = await create()
    await run(b, 'Another session')
    await port.request('sessions.close', { sessionId: b })
    const other = path.join(t.dir, 'other')
    await mkdir(other)
    await port.request('projects.add', { path: other })
    const c = await create(other)

    const list = structured(await call(a, 'list_sessions', {}))
    const sessions = list.sessions as Record<string, unknown>[]
    expect(sessions.map((s) => s.id).sort()).toEqual([a, b].sort())
    expect(sessions.find((s) => s.id === a)).toMatchObject({
      title: 'Caller session',
      agent: 'fake-agent',
      status: 'ready',
      parent_id: null,
      started_by_you: false,
      is_you: true,
      archived: false,
    })
    expect(sessions.find((s) => s.id === b)).toMatchObject({ status: 'closed', is_you: false })

    // A query matches titles as the artifact list does.
    const matching = structured(await call(a, 'list_sessions', { query: 'another' }))
    expect((matching.sessions as Record<string, unknown>[]).map((s) => s.id)).toEqual([b])

    // A closed session's latest reply is read from its stored thread.
    const read = structured(await call(a, 'get_session', { id: b }))
    expect(read).toMatchObject({ id: b, status: 'closed' })
    expect(String(read.last_reply)).toContain('the flake is gone')

    // Another project's session is not found, and its id is not listed.
    expect(code(await call(a, 'get_session', { id: c }))).toBe('not_found')
    expect(sessions.some((s) => s.id === c)).toBe(false)

    // The agent title, then a title the user gave, which still wins.
    expect(structured(await call(a, 'rename_session', { title: 'Agent title' }))).toMatchObject({
      title: 'Agent title',
    })
    await port.request('sessions.rename', { sessionId: a, title: 'User title' })
    expect(structured(await call(a, 'rename_session', { title: 'Agent again' }))).toMatchObject({
      title: 'User title',
    })
    expect(port.summary(a)?.title).toBe('User title')

    // A session the caller did not start is not its to rename.
    expect(code(await call(a, 'rename_session', { id: b, title: 'Nope' }))).toBe('not_allowed')
    expect(code(await call(a, 'rename_session', { title: '   ' }))).toBe('invalid')
    expect(code(await call(a, 'list_sessions', { limit: 0 }))).toBe('invalid')
  })

  it('starts a sub-session with its first message labelled and a started entry', async () => {
    const { port, call, create, run } = await setup()
    const a = await create()
    await run(a, 'Caller session')

    const started = structured(
      await call(a, 'start_session', { prompt: 'Say hello', title: 'Child task' }),
    )
    const child = started.id as string
    expect(started).toMatchObject({
      title: 'Child task',
      parent_id: a,
      started_by_you: true,
      is_you: false,
      archived: false,
    })

    // The caller's thread says what it started, at the tool call's place.
    await port.untilEntry(a, (e) => e.kind === 'session_started')
    const entry = port.entries(a).find((e) => e.kind === 'session_started')
    expect(entry).toMatchObject({ kind: 'session_started', sessionId: child })

    // The new session's first message says whose it is, and its title is the one given.
    await port.open(child)
    const first = port.entries(child).find((e) => e.kind === 'user')
    expect(first).toMatchObject({
      kind: 'user',
      content: [{ type: 'text', text: 'Say hello' }],
      from: { sessionId: a, title: 'Caller session' },
    })

    // A started session cannot start sessions itself: one level.
    await port.untilStatus(child, 'ready')
    expect(code(await call(child, 'start_session', { prompt: 'Nested' }))).toBe('not_allowed')
  })

  it('limits a caller to three sessions working at once', async () => {
    const { port, call, create } = await setup()
    const a = await create()
    const started: string[] = []
    for (let i = 0; i < 3; i++) {
      const reply = structured(await call(a, 'start_session', { prompt: '/long-turn' }))
      started.push(reply.id as string)
      await port.until(() => port.summary(reply.id as string)?.status === 'running')
    }
    const refused = await call(a, 'start_session', { prompt: '/long-turn' })
    expect(code(refused)).toBe('limit')
    expect((refused.result!.structuredContent as { message: string }).message).toContain(
      '3 sessions working',
    )
    for (const id of started) await port.request('sessions.cancel', { sessionId: id })
  })

  it('sends a message when a started session is free, and queues it while it works', async () => {
    const { port, call, create } = await setup()
    const a = await create()
    const started = structured(await call(a, 'start_session', { prompt: 'Say hello' }))
    const child = started.id as string
    await port.open(child)
    await port.untilStatus(child, 'ready')

    expect(structured(await call(a, 'send_message', { id: child, text: 'One more' }))).toEqual({
      id: child,
      delivered: 'sent',
    })
    await port.until(() => port.summary(child)?.status === 'ready')
    const sent = port
      .entries(child)
      .filter((e) => e.kind === 'user')
      .at(-1)
    expect(sent).toMatchObject({
      content: [{ type: 'text', text: 'One more' }],
      from: { sessionId: a, title: 'Untitled session' },
    })

    // While it works the message waits in its queue.
    await port.request('sessions.prompt', {
      sessionId: child,
      content: [{ type: 'text', text: '/long-turn' }],
    })
    await port.untilStatus(child, 'running')
    expect(structured(await call(a, 'send_message', { id: child, text: 'Wait' }))).toEqual({
      id: child,
      delivered: 'queued',
    })
    await port.until(() => port.thread(child).session.queue.length === 1)
    await port.request('sessions.cancel', { sessionId: child })

    // Only a session the caller started takes a message, never the caller itself.
    expect(code(await call(a, 'send_message', { id: a, text: 'Hi' }))).toBe('not_allowed')
    const b = await create()
    expect(code(await call(a, 'send_message', { id: b, text: 'Hi' }))).toBe('not_allowed')
    expect(code(await call(a, 'send_message', { id: b, text: '' }))).toBe('invalid')
  })

  it('archives the caller after its turn ends, and a started session at once', async () => {
    const { port, call, create } = await setup()
    const a = await create()
    await port.request('sessions.prompt', {
      sessionId: a,
      content: [{ type: 'text', text: '/long-turn' }],
    })
    await port.untilStatus(a, 'running')

    expect(structured(await call(a, 'archive_session', {}))).toEqual({
      id: a,
      archived: 'after_turn',
    })
    // Nothing is archived while the turn runs.
    expect(port.summary(a)?.archivedAt).toBeNull()
    await port.request('sessions.cancel', { sessionId: a })
    await port.until(() => (port.summary(a)?.archivedAt ?? null) !== null)
    await port.untilEntry(
      a,
      (e) => e.kind === 'notice' && e.title === 'Fake agent archived this session',
    )
    expect(port.summary(a)?.status).toBe('closed')

    // A started session that is not working is archived now, with its notice.
    const b = await create()
    const started = structured(await call(b, 'start_session', { prompt: 'Say hello' }))
    const child = started.id as string
    await port.open(child)
    await port.untilStatus(child, 'ready')
    expect(structured(await call(b, 'archive_session', { id: child }))).toEqual({
      id: child,
      archived: 'now',
    })
    await port.until(() => (port.summary(child)?.archivedAt ?? null) !== null)
    await port.untilEntry(
      child,
      (e) => e.kind === 'notice' && e.title === 'Fake agent archived this session',
    )

    // A started session that works is busy; another session is not the caller's to archive.
    const working = structured(await call(b, 'start_session', { prompt: '/long-turn' }))
    await port.untilStatus(working.id as string, 'running')
    expect(code(await call(b, 'archive_session', { id: working.id as string }))).toBe('busy')
    expect(code(await call(b, 'archive_session', { id: a }))).toBe('not_allowed')
    await port.request('sessions.cancel', { sessionId: working.id as string })
  })

  it("tells sessions apart on an agent's folder token, as OpenCode names them", async () => {
    const { port, call, create } = await setup()
    vi.spyOn(current!.host.agents, 'mcpServersByName').mockReturnValue(true)
    const a = await create()
    const b = await create()
    const acp = (id: string) => port.thread(id).session.acpSessionId!
    const meta = (acpSessionId: string) => ({ 'ai.opencode/sessionID': acpSessionId })

    const fromA = structured(await call(a, 'list_sessions', {}, meta(acp(a))))
    expect((fromA.sessions as Record<string, unknown>[]).find((s) => s.id === a)).toMatchObject({
      is_you: true,
    })
    const fromB = structured(await call(b, 'get_session', {}, meta(acp(b))))
    expect(fromB).toMatchObject({ id: b, is_you: true })

    // A call that names no session of the folder is refused before any tool runs.
    const refused = await call(a, 'get_session', {}, meta('not-a-session'))
    expect(refused.error?.message).toMatch(/names no session of this agent in this folder/)
  })
})
