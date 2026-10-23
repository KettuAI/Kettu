// Integration tests: the artifacts service as sessions attach, work and go, through the host and
// its port, against the fake agent running in-process.

import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from '../testing/harness'

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
  const servers = t.host.artifactService.servers.bind(t.host.artifactService)
  vi.spyOn(t.host.artifactService, 'servers').mockImplementation((sessionId, project, name) => {
    const given = servers(sessionId, project, name)
    attached.push({ sessionId, servers: given })
    return given
  })
  const create = async (projectPath = t.project) => {
    const summary = await port.request('sessions.create', { agentId: 'fake-agent', projectPath })
    await port.open(summary.id)
    return summary.id
  }
  return { t, port, attached, create }
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

  it('passes nothing to an agent without MCP over HTTP', async () => {
    const { port, attached, create } = await setup({ agentEnv: { FAKE_AGENT_WITHOUT: 'mcp' } })
    const sessionId = await create()
    expect(await run(port, sessionId, '/artifacts')).toBe('This session has no artifacts service.')
    expect(attached).toEqual([])
  })
})
