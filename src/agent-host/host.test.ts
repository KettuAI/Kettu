// The host as main and the renderer see it: the port envelope, main's messages, the state
// files and the git wiring.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitStatus, GitTools, PullRequest } from '@shared/git'
import type { GitEventDraft, GitServiceApi } from './git/api'
import { startTestHost, type TestHost } from './testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  current = await startTestHost(options)
  return { t: current, port: current.connect() }
}

describe('the port envelope', () => {
  it('answers unknown methods and invalid params, and ignores what is not a request', async () => {
    const { t, port } = await setup()
    await expect(
      port.request('sessions.explode' as 'agents.list', undefined),
    ).rejects.toMatchObject({ code: 'unknown_method' })
    await expect(
      port.request('sessions.create', { agentId: 'fake-agent', projectPath: 'relative' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      port.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: path.join(t.dir, 'missing'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    // Neither failed request left anything behind.
    expect(await port.request('sessions.list', {})).toEqual([])
    expect(await port.request('projects.list', undefined)).toEqual([])
    expect(port.events.some((e) => e.type === 'session.summary')).toBe(false)

    port.post({ type: 'request', id: 'one', method: 'agents.list' })
    port.post('hello')
    await port.request('agents.environment', undefined)
    const warnings = t.host.diagnostics.logEntries().filter((entry) => entry.level === 'warn')
    expect(warnings.map((entry) => entry.message)).toEqual([
      expect.stringContaining('numeric id'),
      expect.stringContaining('not a request'),
    ])
  })

  it('answers not_found for sessions that do not exist', async () => {
    const { port } = await setup()
    for (const method of ['sessions.open', 'sessions.watch', 'sessions.close'] as const) {
      await expect(port.request(method, { sessionId: 'nope' })).rejects.toMatchObject({
        code: 'not_found',
      })
    }
  })

  it('reports the agents and waits for the first detection', async () => {
    const { port } = await setup()
    const agents = await port.request('agents.list', undefined)
    expect(agents.map((a) => [a.id, a.state])).toEqual([
      ['claude-code', 'not-installed'],
      ['codex', 'not-installed'],
      ['opencode', 'not-installed'],
      ['fake-agent', 'available'],
    ])
    const fake = agents.find((a) => a.id === 'fake-agent')!
    expect(fake.launchCommand).toContain('main.ts')
    expect(fake.launchCommand).toContain('ELECTRON_RUN_AS_NODE')
    const environment = await port.request('agents.environment', undefined)
    expect(environment).toMatchObject({ source: 'inherited' })
    const reloaded = await port.request('agents.reloadEnvironment', undefined)
    expect(reloaded).toHaveLength(4)
  })
})

describe('main messages', () => {
  it('reports projects, busy sessions and a clean stop', async () => {
    const { t, port } = await setup()
    expect(t.sent.slice(0, 2)).toEqual([
      { type: 'host:projects', paths: [] },
      { type: 'host:ready' },
    ])
    const project = await port.request('projects.add', { path: t.project })
    expect(project).toMatchObject({ path: t.project, missing: false, name: 'project' })
    expect(t.sent).toContainEqual({ type: 'host:projects', paths: [t.project] })
    expect(port.events).toContainEqual({ type: 'projects.changed', projects: [project] })

    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    await port.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: '/permission' }],
    })
    await port.until(() => port.summary(session.id)?.permissionCount === 1)
    t.host.busy(7)
    expect(t.sent.at(-1)).toEqual({
      type: 'host:busy',
      requestId: 7,
      sessions: [{ sessionId: session.id, agentId: 'fake-agent', title: 'Run the login tests' }],
    })

    await t.host.shutdown()
    expect(t.sent.at(-1)).toEqual({ type: 'host:stopped' })
    const index = JSON.parse(await readFile(path.join(t.dir, 'state', 'sessions.json'), 'utf8'))
    expect(index).toMatchObject({ version: 1, sessions: [{ id: session.id }] })
    const projects = JSON.parse(await readFile(path.join(t.dir, 'state', 'projects.json'), 'utf8'))
    expect(projects).toMatchObject({ version: 1, projects: [{ path: t.project }] })
  })

  it('removes a project with its sessions from the index', async () => {
    const { t, port } = await setup()
    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(await port.request('projects.list', undefined)).toHaveLength(1)
    await port.request('projects.touch', { path: t.project })
    await port.request('projects.remove', { path: t.project })
    expect(await port.request('projects.list', undefined)).toEqual([])
    expect(port.events).toContainEqual({ type: 'session.removed', sessionId: session.id })
    await expect(port.request('projects.touch', { path: t.project })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('moves a corrupt state file aside and says so', async () => {
    const first = await startTestHost()
    await first.host.shutdown()
    await mkdir(path.join(first.dir, 'state'), { recursive: true })
    await writeFile(path.join(first.dir, 'state', 'sessions.json'), '{ not json')
    current = await startTestHost({ userDataPath: first.dir })
    const files = await readdir(path.join(first.dir, 'state'))
    expect(files.some((file) => file.startsWith('sessions.json.corrupt-'))).toBe(true)
    expect(current.sent).toContainEqual(
      expect.objectContaining({ type: 'host:log', level: 'error' }),
    )
  })

  it('applies new settings live', async () => {
    const { t, port } = await setup()
    await port.request('agents.list', undefined)
    await t.host.updateSettings({
      agents: { opencode: { binaryPath: path.join(t.dir, 'no-opencode') } },
      proxy: { mode: 'custom', url: 'http://proxy.test:8080', noProxy: 'localhost' },
      git: { backgroundFetch: true },
    })
    const opencode = (await port.request('agents.list', undefined)).find((a) => a.id === 'opencode')
    expect(opencode?.binaryOverride).toBe(path.join(t.dir, 'no-opencode'))
    expect(t.host.env.agentEnv().HTTPS_PROXY).toBe('http://proxy.test:8080')
  })
})

function fakeGit() {
  const calls: string[] = []
  const listeners = {
    changed: new Set<(status: GitStatus) => void>(),
    pr: new Set<(projectPath: string, pr: PullRequest | null) => void>(),
    branchPrs: new Set<(projectPath: string) => void>(),
    events: new Set<(sessionId: string, events: GitEventDraft[]) => void>(),
    tools: new Set<(tools: GitTools) => void>(),
  }
  const on =
    <T>(set: Set<T>) =>
    (listener: T) => {
      set.add(listener)
      return () => set.delete(listener)
    }
  let branch: string | null = 'main'
  let prs = new Map<string, { number: number; state: 'open'; url: string }>()
  const status = (projectPath: string): GitStatus => ({
    projectPath,
    repo: { root: projectPath, gitDir: path.join(projectPath, '.git') },
    head: { branch, oid: 'abc', detached: false },
    upstream: null,
    base: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: null,
    lastFetchedAt: null,
    updatedAt: 1,
    stale: false,
  })
  const tools: GitTools = {
    git: { found: true, version: '2.50.0' },
    gh: { state: 'ready', version: '2.80.0', account: 'me' },
  }
  const service: GitServiceApi = {
    status: async (p) => (calls.push(`status ${p}`), status(p)),
    retain: (p, id) => void calls.push(`retain ${p} ${id}`),
    release: (p, id) => void calls.push(`release ${p} ${id}`),
    releaseAll: (id) => void calls.push(`releaseAll ${id}`),
    fetch: async () => {
      throw new Error('fatal: could not read from remote')
    },
    pullRequest: async (url) => ({
      url,
      owner: 'a',
      repo: 'b',
      number: 1,
      title: 'Fix',
      state: 'open',
      head: 'fix',
      base: 'main',
      checks: { state: 'passing', passed: 1, failed: 0, pending: 0 },
      review: null,
      mergeable: 'clean',
      updatedAt: 1,
    }),
    currentPullRequest: async () => null,
    branchPullRequests: () => prs,
    currentBranch: () => branch,
    tools: async () => tools,
    reloadTools: async () => tools,
    setEnvironment: () => void calls.push('setEnvironment'),
    setBackgroundFetch: (enabled) => void calls.push(`setBackgroundFetch ${enabled}`),
    toolCallStarted: (_p, _s, id) => void calls.push(`toolCallStarted ${id}`),
    toolCallEnded: (_p, _s, id, kind, output) =>
      void calls.push(`toolCallEnded ${id} ${kind} ${output.length > 0}`),
    turnEnded: (_p, sessionId) => void calls.push(`turnEnded ${sessionId}`),
    onChanged: on(listeners.changed),
    onPullRequest: on(listeners.pr),
    onBranchPullRequests: on(listeners.branchPrs),
    onSessionEvents: on(listeners.events),
    onTools: on(listeners.tools),
    dispose: async () => void calls.push('dispose'),
  }
  return {
    service,
    calls,
    listeners,
    status,
    setBranch: (value: string | null) => (branch = value),
    setPrs: (value: typeof prs) => (prs = value),
  }
}

describe('git', () => {
  it('answers git_error while there is no git service', async () => {
    const { t, port } = await setup()
    await expect(port.request('git.status', { projectPath: t.project })).rejects.toMatchObject({
      code: 'git_error',
      message: 'Git is not available yet',
    })
    await expect(port.request('git.tools', undefined)).rejects.toMatchObject({ code: 'git_error' })
  })

  it('keeps projects live per port and forwards changes to those ports only', async () => {
    const git = fakeGit()
    const { t, port } = await setup({ git: git.service })
    const other = t.connect()
    expect(git.calls).toContain('setBackgroundFetch false')
    const status = await port.request('git.status', { projectPath: t.project })
    expect(status.head.branch).toBe('main')
    await port.request('git.status', { projectPath: t.project })
    expect(git.calls.filter((c) => c.startsWith('retain'))).toHaveLength(1)

    for (const listener of git.listeners.changed) listener(git.status(t.project))
    for (const listener of git.listeners.tools) {
      listener({
        git: { found: true, version: '2' },
        gh: { state: 'signed-out', version: null, account: null },
      })
    }
    expect(port.events.filter((e) => e.type === 'git.changed')).toHaveLength(1)
    expect(other.events.some((e) => e.type === 'git.changed')).toBe(false)
    expect(other.events.some((e) => e.type === 'git.tools')).toBe(true)

    await expect(port.request('git.fetch', { projectPath: t.project })).rejects.toMatchObject({
      code: 'git_error',
      message: 'fatal: could not read from remote',
    })
    await port.request('git.unwatch', { projectPath: t.project })
    expect(git.calls).toContainEqual(expect.stringMatching(/^release .* port-1$/))
    await other.request('git.status', { projectPath: t.project })
    other.disconnect()
    expect(git.calls).toContain('releaseAll port-2')

    await t.host.updateSettings({
      agents: {},
      proxy: { mode: 'environment' },
      git: { backgroundFetch: true },
    })
    expect(git.calls).toContain('setBackgroundFetch true')
  })

  it('wires turns, branches, pull requests and git events into sessions', async () => {
    const git = fakeGit()
    const { t, port } = await setup({ git: git.service })
    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    await port.open(created.id)
    await port.request('sessions.prompt', {
      sessionId: created.id,
      content: [{ type: 'text', text: 'hello' }],
    })
    await port.untilStatus(created.id, 'ready')
    expect(git.calls).toContain(`turnEnded ${created.id}`)
    expect(git.calls.some((c) => c.startsWith('toolCallStarted'))).toBe(true)
    expect(git.calls.some((c) => c.startsWith('toolCallEnded') && c.includes('edit'))).toBe(true)
    expect(port.summary(created.id)).toMatchObject({ branch: 'main', pr: null })

    git.setPrs(
      new Map([['main', { number: 7, state: 'open', url: 'https://github.com/a/b/pull/7' }]]),
    )
    for (const listener of git.listeners.branchPrs) listener(t.project)
    expect(port.summary(created.id)?.pr).toEqual({
      number: 7,
      state: 'open',
      url: 'https://github.com/a/b/pull/7',
    })

    const counter = Math.max(
      ...port
        .entries(created.id)
        .flatMap((e) => (e.id.startsWith('e:') ? [Number(e.id.slice(2))] : [])),
    )
    for (const listener of git.listeners.events) {
      listener(created.id, [
        { kind: 'git', event: 'commit', commits: [{ oid: 'abc', subject: 'Fix it' }], more: 0 },
        { kind: 'git', event: 'push', upstream: 'origin/main', count: 1 },
      ])
    }
    await port.until(() => port.entries(created.id).some((e) => e.kind === 'git'))
    const gitEntries = port.entries(created.id).filter((e) => e.kind === 'git')
    expect(gitEntries.map((e) => e.id)).toEqual([`g:${counter + 1}`, `g:${counter + 2}`])
  })
})
