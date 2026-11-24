import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { USER_ROLES_DIR } from './roles/service'
import { FakeAppServer } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const REVIEWER = `---
name: Reviewer
description: Reviews a change
agent: codex
---
Review the change and report only what is wrong.
`

const NEEDY = `---
skills: [code-review]
---
Needs a skill.
`

const BLOCK =
  '<kettu-role name="Reviewer">\nReview the change and report only what is wrong.\n</kettu-role>'

/** A data folder with the user's roles in it, which the host started in it reads. */
async function dataWithRoles(): Promise<string> {
  const dir = await tempFolder('kettu-session-roles-')
  const folder = path.join(dir, USER_ROLES_DIR)
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, 'reviewer.md'), REVIEWER)
  await writeFile(path.join(folder, 'needy.md'), NEEDY)
  return dir
}

/** Sends a prompt and gives the agent's reply once its turn is over. */
async function reply(port: TestPort, sessionId: string, text: string): Promise<string> {
  const replies = () =>
    port.entries(sessionId).flatMap((entry) => (entry.kind === 'agent' ? [entry] : []))
  const before = replies().length
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await port.until(
    () =>
      replies().length > before &&
      !replies().at(-1)!.streaming &&
      port.summary(sessionId)?.status === 'ready',
  )
  return replies().at(-1)!.markdown
}

/** What the fake agent was sent with the session's first message, as it recalls it. */
async function firstMessage(port: TestPort, sessionId: string): Promise<string> {
  await reply(port, sessionId, 'hello')
  return reply(port, sessionId, '/recall')
}

it('lists the roles for New session', async () => {
  const host = await startTestHost({ userDataPath: await dataWithRoles() })
  hosts.push(host)
  const { roles } = await host.connect().request('roles.list', undefined)
  expect(roles.map((role) => [role.ref, role.title, role.suggests])).toEqual([
    ['needy', 'needy', {}],
    ['reviewer', 'Reviewer', { agent: 'codex' }],
  ])
})

it('gives an ACP agent the role ahead of its first message with the guide, and says so in the thread', async () => {
  const host = await startTestHost({ userDataPath: await dataWithRoles() })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
    role: 'reviewer',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const recalled = await firstMessage(window, id)
  expect(recalled).toMatch(/^Your last message was: <kettu-guide>\n/)
  // The guide, then memory, then the role, then what the user wrote.
  expect(recalled).toMatch(
    /<\/kettu-guide>\n\n<kettu-memory>[\s\S]*<\/kettu-memory>\n\n<kettu-role/,
  )
  expect(recalled.endsWith(`</kettu-memory>\n\n${BLOCK}\n\nhello`)).toBe(true)
  expect(window.entries(id)).toContainEqual(
    expect.objectContaining({ kind: 'notice', title: 'Started as the role Reviewer' }),
  )
})

it('gives a session an agent started through the session tools the same instructions', async () => {
  const host = await startTestHost({ userDataPath: await dataWithRoles() })
  hosts.push(host)
  const window = host.connect()
  const caller = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  const id = await host.host.sessions.startFromTool(caller.id, {
    prompt: 'hello',
    options: {},
    report: false,
    role: 'reviewer',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const recalled = await reply(window, id, '/recall')
  expect(recalled.endsWith(`${BLOCK}\n\nhello`)).toBe(true)
})

it("gives a workflow step's session the step's role", async () => {
  const host = await startTestHost({ userDataPath: await dataWithRoles() })
  hosts.push(host)
  const window = host.connect()
  const { id } = await host.host.sessions.createStep({
    agentId: 'fake-agent',
    projectPath: host.project,
    worktree: null,
    prepare: false,
    options: {},
    prompt: 'hello',
    title: 'Review',
    task: { taskId: 'task-1', stepId: 'review', roundId: 'round-1' },
    role: 'reviewer',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await vi.waitFor(() => expect(window.summary(id)?.status).toBe('ready'))
  const recalled = await reply(window, id, '/recall')
  expect(recalled.endsWith(`${BLOCK}\n\nhello`)).toBe(true)
})

it('starts no session as a role that does not exist or needs a skill that is not installed', async () => {
  const host = await startTestHost({ userDataPath: await dataWithRoles() })
  hosts.push(host)
  const window = host.connect()
  await expect(
    window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
      role: 'nobody',
    }),
  ).rejects.toThrow(/no role named nobody/i)
  await expect(
    window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
      role: 'needy',
    }),
  ).rejects.toThrow(/code-review/)
  expect(
    (await window.request('sessions.list', { projectPath: host.project })).map((s) => s.id),
  ).toEqual([])
})

function codexServer(): FakeAppServer {
  return new FakeAppServer()
}

it('gives Codex the role as its developer instructions, and again when the thread resumes', async () => {
  const dir = await dataWithRoles()
  const server = codexServer()
  const first = await startTestHost({
    userDataPath: dir,
    fakeAppServer: server,
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(first)
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: first.project,
    role: 'reviewer',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  expect(server.sent('thread/start')[0]).toMatchObject({
    developerInstructions: expect.stringContaining(BLOCK) as unknown,
  })
  await first.stop()
  hosts.splice(0)

  // The first host closed its server; the thread is resumed on a new one.
  const resumed = codexServer()
  const second = await startTestHost({
    userDataPath: dir,
    fakeAppServer: resumed,
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(second)
  const again = second.connect()
  await again.open(id)
  void again.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'carry on' }],
  })
  await vi.waitFor(() => expect(resumed.sent('thread/resume').length).toBeGreaterThan(0))
  expect(resumed.sent('thread/resume')[0]).toMatchObject({
    developerInstructions: expect.stringContaining(BLOCK) as unknown,
  })
})

it('gives Codex the role of a session started through the session tools and of a workflow step', async () => {
  const server = codexServer()
  const host = await startTestHost({
    userDataPath: await dataWithRoles(),
    fakeAppServer: server,
  })
  hosts.push(host)
  const window = host.connect()
  const caller = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await host.host.sessions.startFromTool(caller.id, {
    prompt: 'hello',
    options: {},
    report: false,
    role: 'reviewer',
  })
  await host.host.sessions.createStep({
    agentId: 'codex',
    projectPath: host.project,
    worktree: null,
    prepare: false,
    options: {},
    prompt: 'hello',
    title: 'Review',
    task: { taskId: 'task-1', stepId: 'review', roundId: 'round-1' },
    role: 'reviewer',
  })
  const withRole = () =>
    server.sent('thread/start').filter((params) => JSON.stringify(params).includes('<kettu-role'))
  await vi.waitFor(() => expect(withRole()).toHaveLength(2))
  for (const params of withRole()) {
    expect(params).toMatchObject({
      developerInstructions: expect.stringContaining(BLOCK) as unknown,
    })
  }
})

it('keeps giving the role to the agent a session switches to', async () => {
  const server = codexServer()
  const host = await startTestHost({ userDataPath: await dataWithRoles(), fakeAppServer: server })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
    role: 'reviewer',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.switchAgent', {
    sessionId: id,
    agentId: 'codex',
    content: [{ type: 'text', text: 'carry on' }],
  })
  await vi.waitFor(() =>
    expect(
      server
        .sent('thread/start')
        .some((params) => String(params.developerInstructions ?? '').includes(BLOCK)),
    ).toBe(true),
  )
})

it('gives the role again after the agent compacts its context', async () => {
  const host = await startTestHost({ userDataPath: await dataWithRoles() })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
    role: 'reviewer',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await reply(window, id, 'hello')
  const ends = () => window.entries(id).filter((entry) => entry.kind === 'turn_end').length
  const before = ends()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/compact' }],
  })
  await window.until(() => ends() > before && window.summary(id)?.status === 'ready')
  await reply(window, id, 'again')
  const next = await reply(window, id, '/recall')
  expect(next.endsWith(`${BLOCK}\n\nagain`)).toBe(true)
})
