// Integration tests: the artifacts service as sessions attach, work and go, through the host and
// its port, against the fake agent running in-process.

import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { ArtifactEntry } from '@shared/thread'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startTestHost,
  type InProcessLauncher,
  type TestHost,
  type TestPort,
} from '../testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

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
  const create = async (projectPath = t.project) => (await start(projectPath)).id
  const start = async (projectPath = t.project) => {
    const summary = await port.request('sessions.create', { agentId: 'fake-agent', projectPath })
    await port.open(summary.id)
    return summary
  }
  return { t, port, attached, create, start }
}

function turnEnds(port: TestPort, sessionId: string): number {
  return port.replicas.has(sessionId)
    ? port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
    : 0
}

/** Sends a prompt and waits for its turn to end; returns the reply's text. */
async function run(port: TestPort, sessionId: string, text: string): Promise<string> {
  const before = turnEnds(port, sessionId)
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await port.until(() => turnEnds(port, sessionId) > before)
  const reply = port.entries(sessionId).findLast((entry) => entry.kind === 'agent')
  return reply?.kind === 'agent' ? reply.markdown : ''
}

/** The artifact entries of a session's thread, in order. */
function cards(port: TestPort, sessionId: string): ArtifactEntry[] {
  return port.entries(sessionId).filter((entry) => entry.kind === 'artifact')
}

function tokenOf(servers: McpServer[]): string {
  const server = servers[0] as { headers: { name: string; value: string }[] }
  return server.headers.find((h) => h.name === 'Authorization')!.value
}

async function listTools(url: string, authorization: string): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  return response.status
}

describe('the artifacts service in sessions', () => {
  it('adds one entry per artifact and turn after the call that wrote it, and none for reads', async () => {
    const { port, create } = await setup()
    const sessionId = await create()
    await run(port, sessionId, '/artifacts')
    await run(port, sessionId, '/artifacts')
    const [artifact] = await port.request('artifacts.list', {})
    const order = port
      .entries(sessionId)
      .filter((entry) => entry.kind === 'tool' || entry.kind === 'artifact')
      .map((entry) => (entry.kind === 'tool' ? entry.title : `${entry.action} v${entry.version}`))
    expect(order).toEqual([
      'mcp__overbench__list_artifacts',
      'mcp__overbench__create_artifact',
      'create v1',
      'mcp__overbench__read_artifact',
      'mcp__overbench__list_artifacts',
      'mcp__overbench__update_artifact',
      'update v2',
      'mcp__overbench__read_artifact',
    ])
    expect(cards(port, sessionId)[0]).toEqual({
      kind: 'artifact',
      id: expect.stringMatching(/^a:\d+$/),
      artifactId: artifact!.id,
      title: 'Fake canvas',
      action: 'create',
      version: 1,
      writes: 1,
      after: 't:overbench-1-2',
    })
  })

  it('shows every write from code an execute call runs, as one entry for the turn', async () => {
    const { port, create } = await setup()
    const sessionId = await create()
    await run(port, sessionId, '/artifacts --execute')
    const entries = port.entries(sessionId)
    const tools = entries.filter((entry) => entry.kind === 'tool')
    expect(tools.map((entry) => entry.title)).toEqual(['execute'])
    expect(cards(port, sessionId)).toEqual([
      expect.objectContaining({ action: 'create', version: 2, writes: 2, after: tools[0]!.id }),
    ])
    const at = entries.findIndex((entry) => entry.kind === 'artifact')
    expect(entries[at - 1]?.id).toBe(tools[0]!.id)
  })

  it('adds a write that comes after the turn ended to the latest turn', async () => {
    const { port, attached, create } = await setup()
    const sessionId = await create()
    await run(port, sessionId, '/artifacts')
    const [artifact] = await port.request('artifacts.list', {})
    const token = tokenOf(attached[0]!.servers)
    const url = (attached[0]!.servers[0] as { url: string }).url
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delete_artifact', arguments: { id: artifact!.id } },
      }),
    })
    expect(response.status).toBe(200)
    await port.until(() => cards(port, sessionId).length === 2)
    expect(port.entries(sessionId).at(-1)).toMatchObject({
      kind: 'artifact',
      action: 'delete',
      version: null,
      title: 'Fake canvas',
    })
  })

  it('passes the service with a token of its own on every attach', async () => {
    const { t, port, attached, create } = await setup()
    const sessionId = await create()
    expect(attached).toEqual([
      {
        sessionId,
        servers: [
          {
            type: 'http',
            name: 'overbench',
            url: t.host.artifactService.url,
            headers: [{ name: 'Authorization', value: expect.stringMatching(/^Bearer /) }],
          },
        ],
      },
    ])
    const reply = await run(port, sessionId, '/artifacts')
    expect(reply).toMatch(/^list_artifacts: No artifact title in this project matches/)
    expect(reply).toMatch(/create_artifact: Created art_\w+ version 1, a canvas of 2 pages\./)
    expect(reply).toMatch(/html: revision 1$/)
    const [artifact] = await port.request('artifacts.list', {})
    expect(artifact).toMatchObject({
      title: 'Fake canvas',
      project: t.project,
      sessionId,
      version: 1,
      pages: 2,
      editing: [],
    })
    const tool = port
      .entries(sessionId)
      .find((entry) => entry.kind === 'tool' && entry.title.includes('create_artifact'))
    expect(tool).toMatchObject({ title: 'mcp__overbench__create_artifact', status: 'completed' })

    // A closed session's token ends; attaching again makes a new one.
    const first = tokenOf(attached[0]!.servers)
    const url = t.host.artifactService.url!
    expect(await listTools(url, first)).toBe(200)
    await port.request('sessions.close', { sessionId })
    expect(await listTools(url, first)).toBe(401)
    const again = await run(port, sessionId, '/artifacts')
    expect(again).toMatch(/update_artifact: Updated art_\w+ to version 2, a canvas of 2 pages\./)
    expect(again).toMatch(/html: revision 2$/)
    expect(attached).toHaveLength(2)
    const second = tokenOf(attached[1]!.servers)
    expect(second).not.toBe(first)
    expect(await listTools(url, second)).toBe(200)

    // A fork attaches with a token for itself, which ends when it is deleted.
    const fork = await port.request('sessions.fork', { sessionId })
    expect(attached.at(-1)!.sessionId).toBe(fork.id)
    const forkToken = tokenOf(attached.at(-1)!.servers)
    await port.open(fork.id)
    expect(await run(port, fork.id, '/artifacts')).toMatch(/to version 3/)
    const versions = await port.request('artifacts.versions', { id: artifact!.id })
    expect(versions.map((v) => [v.version, v.author])).toEqual([
      [3, fork.id],
      [2, sessionId],
      [1, sessionId],
    ])
    await port.request('sessions.delete', { sessionId: fork.id })
    expect(await listTools(url, forkToken)).toBe(401)
    expect(await listTools(url, second)).toBe(200)

    await t.stop()
    current = null
    expect(t.host.artifactService.url).toBeNull()
  })

  it('shows a session as editing while its turn writes, until the turn ends', async () => {
    const { port, create } = await setup()
    const sessionId = await create()
    await run(port, sessionId, '/artifacts')
    const [artifact] = await port.request('artifacts.list', {})
    const id = artifact!.id
    await port.request('artifacts.watch', { id })
    const activity = () =>
      port.events.flatMap((event) =>
        event.type === 'artifacts.activity' && event.id === id ? [event.editing] : [],
      )
    const changes = port.events.filter((event) => event.type === 'artifacts.changed').length
    await run(port, sessionId, '/artifacts')
    await port.until(() => activity().length >= 3)
    expect(activity()).toEqual([[], [sessionId], []])
    // The cards read who edits from the list, so its end is a change of the list.
    const changed = port.events.filter((event) => event.type === 'artifacts.changed').length
    expect(changed).toBe(changes + 2)
    expect((await port.request('artifacts.list', {}))[0]!.editing).toEqual([])
  })

  it.each(['cancel', 'close', 'exit'] as const)(
    'ends editing when the turn is stopped, the session closes or its agent exits: %s',
    async (end) => {
      const { t, port, create } = await setup()
      const sessionId = await create()
      await run(port, sessionId, '/artifacts')
      const [artifact] = await port.request('artifacts.list', {})
      const id = artifact!.id
      await port.request('artifacts.watch', { id })
      const editing = () =>
        port.events.findLast((event) => event.type === 'artifacts.activity' && event.id === id)
      await port.request('sessions.prompt', {
        sessionId,
        content: [{ type: 'text', text: '/artifacts --until-cancel' }],
      })
      await port.until(() => {
        const last = editing()
        return last?.type === 'artifacts.activity' && last.editing.includes(sessionId)
      })
      expect((await port.request('artifacts.list', {}))[0]!.editing).toEqual([sessionId])
      if (end === 'cancel') await port.request('sessions.cancel', { sessionId })
      else if (end === 'close') await port.request('sessions.close', { sessionId })
      else (t.launcher as InProcessLauncher).crash()
      await port.until(() => {
        const last = editing()
        return last?.type === 'artifacts.activity' && last.editing.length === 0
      })
      expect((await port.request('artifacts.list', {}))[0]!.editing).toEqual([])
    },
  )

  it('keeps two projects apart', async () => {
    const { t, port, create } = await setup()
    const other = path.join(t.dir, 'other')
    await mkdir(other)
    await port.request('projects.add', { path: other })
    const a = await create()
    const b = await create(await realpath(other))
    await run(port, a, '/artifacts')
    const [inA] = await port.request('artifacts.list', {})
    const fromB = await run(port, b, `/artifacts --read ${inA!.id}`)
    expect(fromB).toBe(
      `read_artifact: No artifact ${inA!.id} in this project. ` +
        'list_artifacts shows the ones you can use.',
    )
    expect(await run(port, b, '/artifacts')).toMatch(/create_artifact: Created/)
    const listed = await port.request('artifacts.list', {})
    expect(listed.map((x) => [x.project, x.sessionId]).sort()).toEqual(
      [
        [t.project, a],
        [await realpath(other), b],
      ].sort(),
    )
  })

  describe('for an agent that keeps one server of a name per folder', () => {
    async function folders() {
      const context = await setup()
      vi.spyOn(context.t.host.agents, 'mcpServersByName').mockReturnValue(true)
      const other = path.join(context.t.dir, 'other')
      await mkdir(other)
      await context.port.request('projects.add', { path: other })
      return { ...context, other: await realpath(other) }
    }

    it('passes one token per folder and tells the sessions there apart by their calls', async () => {
      const { port, attached, start, other } = await folders()
      const a = await start()
      const b = await start()
      const c = await start(other)
      const [first, second, third] = attached.map((x) => x.servers)
      expect(first).toEqual(second)
      expect(first).toEqual([expect.objectContaining({ name: 'overbench' })])
      expect(tokenOf(third!)).not.toBe(tokenOf(first!))

      expect(await run(port, a.id, '/artifacts')).toMatch(/create_artifact: Created/)
      expect(await run(port, b.id, '/artifacts')).toMatch(/to version 2/)
      // A subagent's call names its own session, which counts as the one it runs under.
      expect(await run(port, b.id, '/artifacts --child sub-1')).toMatch(/to version 3/)
      const [artifact] = await port.request('artifacts.list', {})
      expect(artifact).toMatchObject({ sessionId: b.id, project: a.projectPath })
      const versions = await port.request('artifacts.versions', { id: artifact!.id })
      expect(versions.map((v) => v.author)).toEqual([b.id, b.id, a.id])
      // Each write shows in the session the call named; a subagent's in the one it runs under.
      expect(cards(port, a.id).map((e) => e.version)).toEqual([1])
      expect(cards(port, b.id).map((e) => e.version)).toEqual([2, 3])
      expect(port.replicas.has('sub-1') ? cards(port, 'sub-1') : []).toEqual([])

      // No session id, one OverBench does not know, and one of another folder.
      const foreign = port.thread(c.id).session.acpSessionId
      expect(foreign).toMatch(/^fake-/)
      for (const meta of ['none', 'unknown-session', foreign]) {
        expect(await run(port, b.id, `/artifacts --meta ${meta}`)).toMatch(
          /^list_artifacts: .*names no session of this agent in this folder/,
        )
      }
    })

    it('ends the token when the last session there leaves memory, or the agent exits', async () => {
      const { t, port, attached, create } = await folders()
      const a = await create()
      const b = await create()
      const url = t.host.artifactService.url!
      const shared = tokenOf(attached[0]!.servers)
      await port.request('sessions.close', { sessionId: a })
      expect(await listTools(url, shared)).toBe(200)
      await port.request('sessions.close', { sessionId: b })
      expect(await listTools(url, shared)).toBe(401)

      await run(port, a, '/artifacts')
      const next = tokenOf(attached.at(-1)!.servers)
      expect(next).not.toBe(shared)
      expect(await listTools(url, next)).toBe(200)
      ;(t.launcher as InProcessLauncher).crash()
      await vi.waitFor(async () => expect(await listTools(url, next)).toBe(401))
      expect(await run(port, a, '/artifacts')).toMatch(/to version 2/)
      expect(tokenOf(attached.at(-1)!.servers)).not.toBe(next)
    })
  })

  it('passes nothing to an agent without MCP over HTTP', async () => {
    const { port, attached, create } = await setup({ agentEnv: { FAKE_AGENT_WITHOUT: 'mcp' } })
    const sessionId = await create()
    expect(await run(port, sessionId, '/artifacts')).toBe('This session has no artifacts service.')
    expect(attached).toEqual([])
  })
})
