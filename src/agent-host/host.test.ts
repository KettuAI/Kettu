// The host as main and the renderer see it: the port envelope, main's messages, the state
// files and the git wiring.

import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_ID, NO_SESSION } from '@shared/artifacts'
import type { GitStatus, GitTools, PullRequest } from '@shared/git'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { ThreadEntry } from '@shared/thread'
import type { AgentLauncher } from './agents'
import type { GitEventDraft, GitServiceApi } from './git/api'
import {
  inProcessLauncher,
  loadFakeAgent,
  startTestHost,
  type TestHost,
  type TestPort,
} from './testing/harness'

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

  it("refuses a paired device's port what needs main, and logs it", async () => {
    const { t, port: window } = await setup()
    const device = t.connect({ id: 'a'.repeat(32), name: 'Phone' })
    await writeFile(path.join(t.project, 'a.txt'), 'x')
    const refused = [
      ['media.open', { projectPath: t.project, path: 'a.txt', sessionId: 'none' }],
      ['attachments.add', { source: { grantId: 'grant' }, thumb: null }],
    ] as const
    for (const [method, params] of refused) {
      await expect(device.request(method, params as never)).rejects.toMatchObject({
        code: 'forbidden',
      })
    }
    expect(await device.request('projects.list', undefined)).toEqual([])

    // A window still may; the device may do everything else, as mention a project's file.
    await window.request('projects.add', { path: t.project })
    expect(await device.request('projects.list', undefined)).toHaveLength(1)
    expect(
      await device.request('attachments.add', {
        source: { projectPath: t.project, path: 'a.txt' },
        thumb: null,
      }),
    ).toMatchObject({ type: 'file', name: 'a.txt' })
    const warnings = t.host.diagnostics.logEntries().filter((entry) => entry.level === 'warn')
    expect(warnings.map((entry) => entry.message)).toEqual(
      refused.map(
        ([method]) => `Device ${'a'.repeat(32)} asked for ${method}, which devices may not call`,
      ),
    )
  })

  it('lets a paired device add a project by its folder, which must be one', async () => {
    const { t } = await setup()
    const device = t.connect({ id: 'a'.repeat(32), name: 'Phone' })
    await writeFile(path.join(t.project, 'a.txt'), 'x')
    for (const folder of [path.join(t.project, 'a.txt'), path.join(t.dir, 'missing'), 'relative']) {
      await expect(device.request('projects.add', { path: folder })).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
    expect(await device.request('projects.list', undefined)).toEqual([])
    expect(await device.request('projects.add', { path: t.project })).toMatchObject({
      path: t.project,
    })
    expect(await device.request('projects.list', undefined)).toHaveLength(1)
  })

  it('completes a path a paired device types, absolute or from the home folder', async () => {
    const { t } = await setup()
    const device = t.connect({ id: 'a'.repeat(32), name: 'Phone' })
    await writeFile(path.join(t.project, 'a.txt'), 'x')
    const done = await device.request('paths.complete', { path: path.join(t.project, 'a') })
    expect(done).toEqual({
      folder: t.project,
      entries: [{ name: 'a.txt', kind: 'file', executable: false }],
      exact: null,
    })
    // The harness's home is its data folder, which holds the project.
    const home = await device.request('paths.complete', { path: '~/' })
    expect(home.entries).toContainEqual({
      name: path.basename(t.project),
      kind: 'folder',
      executable: false,
      repo: false,
    })
    for (const typed of ['relative', '~ada/x', '']) {
      await expect(device.request('paths.complete', { path: typed })).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
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
      ['pi', 'not-installed'],
      ['auggie', 'not-installed'],
      ['codebuddy', 'not-installed'],
      ['deepagents', 'not-installed'],
      ['dimcode', 'not-installed'],
      ['dirac', 'not-installed'],
      ['glm', 'not-installed'],
      ['nova', 'not-installed'],
      ['qoder', 'not-installed'],
      ['sigit', 'not-installed'],
      ['agoragentic', 'not-installed'],
      ['autohand', 'not-installed'],
      ['gemini', 'not-installed'],
      ['copilot', 'not-installed'],
      ['qwen', 'not-installed'],
      ['grok', 'not-installed'],
      ['cline', 'not-installed'],
      ['droid', 'not-installed'],
      ['bob', 'not-installed'],
      ['minimax', 'not-installed'],
      ['cursor', 'not-installed'],
      ['kimi', 'not-installed'],
      ['amp', 'not-installed'],
      ['goose', 'not-installed'],
      ['kilo', 'not-installed'],
      ['omp', 'not-installed'],
      ['hermes', 'not-installed'],
      ['muse', 'not-installed'],
      ['codewhale', 'not-installed'],
      ['harn', 'not-installed'],
      ['kimchi', 'not-installed'],
      ['antigravity', 'not-installed'],
      ['devin', 'not-installed'],
      ['cortex-code', 'not-installed'],
      ['corust-agent', 'not-installed'],
      ['crow-cli', 'not-installed'],
      ['junie', 'not-installed'],
      ['mistral-vibe', 'not-installed'],
      ['poolside', 'not-installed'],
      ['stakpak', 'not-installed'],
      ['vtcode', 'not-installed'],
      ['fast-agent', 'not-installed'],
      ['minion', 'not-installed'],
      ['fake-agent', 'available'],
    ])
    const fake = agents.find((a) => a.id === 'fake-agent')!
    expect(fake.launchCommand).toContain('main.ts')
    expect(fake.launchCommand).toContain('ELECTRON_RUN_AS_NODE')
    const environment = await port.request('agents.environment', undefined)
    expect(environment).toMatchObject({ source: 'inherited' })
    const reloaded = await port.request('agents.reloadEnvironment', undefined)
    expect(reloaded).toHaveLength(47)
  })

  it('starts an agent to prepare a session, and refuses one that cannot run', async () => {
    const { port } = await setup()
    await port.request('sessions.prepare', { agentId: 'fake-agent', projectPath: null })
    const agents = await port.request('agents.list', undefined)
    expect(agents.find((a) => a.id === 'fake-agent')?.state).toBe('ready')
    await expect(
      port.request('sessions.prepare', { agentId: 'codex', projectPath: null }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' })
  })

  it('tells where an agent keeps its configuration, without needing the agent to run', async () => {
    const { port } = await setup()
    expect(await port.request('agents.details', { agentId: 'fake-agent' })).toEqual({
      cliVersion: null,
      config: [],
    })
    const codex = await port.request('agents.details', { agentId: 'codex' })
    expect(codex.config.map((item) => item.id)).toEqual(['folder', 'settings', 'instructions'])
    await expect(
      port.request('agents.details', { agentId: 'unknown-agent' as 'codex' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('main messages', () => {
  it('reports projects, busy sessions and a clean stop', async () => {
    const { t, port } = await setup()
    expect(t.sent.slice(0, 3)).toEqual([
      { type: 'host:projects', paths: [] },
      { type: 'host:service-port', port: expect.any(Number) },
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

  it('writes its state and reports a clean stop when an agent outlasts the quit', async () => {
    const base = inProcessLauncher(await loadFakeAgent())
    const launcher: AgentLauncher = {
      // An agent that ignores EOF and every signal the stop sends.
      launch: (def, spec, env, output) =>
        Object.assign(base.launch(def, spec, env, output), {
          stop: () => new Promise<never>(() => {}),
          kill: async () => {},
        }),
    }
    const { t, port } = await setup({ launcher, agentTimings: { quitStopMs: 100 } })
    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    await t.host.shutdown()
    expect(t.sent.at(-1)).toEqual({ type: 'host:stopped' })
    const index = JSON.parse(await readFile(path.join(t.dir, 'state', 'sessions.json'), 'utf8'))
    expect(index).toMatchObject({ version: 1, sessions: [{ id: session.id }] })
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
      locale: 'en',
      agents: { opencode: { binaryPath: path.join(t.dir, 'no-opencode') } },
      addedAgents: [],
      proxy: { mode: 'custom', url: 'http://proxy.test:8080', noProxy: 'localhost' },
      git: { backgroundFetch: true },
      mcp: DEFAULT_SETTINGS.mcp,
      usage: { fromComputer: false },
      sessionTitles: true,
    })
    const opencode = (await port.request('agents.list', undefined)).find((a) => a.id === 'opencode')
    expect(opencode?.binaryOverride).toBe(path.join(t.dir, 'no-opencode'))
    expect(t.host.env.agentEnv().HTTPS_PROXY).toBe('http://proxy.test:8080')
  })

  it('writes its text in the language main sends', async () => {
    const { t, port } = await setup({
      resolveEnv: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: { key: 'environment.inherited' },
      }),
    })
    const settings = {
      locale: 'en' as const,
      agents: {},
      addedAgents: [],
      proxy: { mode: 'environment' as const },
      git: { backgroundFetch: false },
      mcp: DEFAULT_SETTINGS.mcp,
      usage: { fromComputer: false },
      sessionTitles: true,
    }
    const warning = async () => (await port.request('agents.environment', undefined)).warning
    await port.request('agents.list', undefined)
    expect(await warning()).toMatch(/^Changes to PATH/)
    try {
      const before = port.events.length
      await t.host.updateSettings({ ...settings, locale: 'zh-CN' })
      expect(await warning()).toMatch(/^Kettu 启动后/)
      const after = port.events.slice(before)
      expect(after).toContainEqual(
        expect.objectContaining({
          type: 'environment.changed',
          info: expect.objectContaining({ warning: expect.stringMatching(/^Kettu 启动后/) }),
        }),
      )
    } finally {
      await t.host.updateSettings(settings)
    }
    expect(await warning()).toMatch(/^Changes to PATH/)
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
    defaultBranch: null,
    push: null,
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
    pull: async (p) => (calls.push(`pull ${p}`), { status: status(p), log: 'pulled' }),
    push: async (p, to) => (
      calls.push(`push ${p} ${to.remote}/${to.branch}`),
      { status: status(p), log: 'pushed' }
    ),
    publish: async (p, name, visibility) => (
      calls.push(`publish ${p} ${name} ${visibility}`),
      { status: status(p), log: 'published' }
    ),
    createPullRequest: async () => {
      throw new Error('not used')
    },
    commit: async () => {
      throw new Error('not used')
    },
    changes: async (p) => (calls.push(`changes ${p}`), []),
    incoming: async () => [],
    fileDiff: async (_p, path) => ({
      path,
      oldText: '',
      newText: 'x',
      binary: false,
      tooLarge: false,
    }),
    pullRequest: async (url) => ({
      url,
      owner: 'a',
      repo: 'b',
      number: 1,
      title: 'Fix',
      state: 'open',
      head: 'fix',
      base: 'main',
      checks: { state: 'passing', passed: 1, failed: 0, pending: 0, runs: [] },
      review: null,
      mergeable: 'clean',
      updatedAt: 1,
      author: null,
      createdAt: 1,
      mergedAt: null,
      closedAt: null,
    }),
    avatarUrl: async () => null,
    currentPullRequest: async () => null,
    branchPullRequests: () => prs,
    currentBranch: () => branch,
    tools: async () => (calls.push('tools'), tools),
    reloadTools: async () => (calls.push('reloadTools'), tools),
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

  it('runs git only once the environment is resolved, and re-probes tools on a reload', async () => {
    const git = fakeGit()
    const resolved: (() => void)[] = []
    const { t, port } = await setup({
      git: git.service,
      resolveEnv: ({ baseEnv }) =>
        new Promise((resolve) =>
          resolved.push(() =>
            resolve({
              env: baseEnv,
              source: 'login-shell',
              shell: 'zsh',
              durationMs: 1,
              warning: null,
            }),
          ),
        ),
    })
    await port.request('projects.add', { path: t.project })
    const tools = port.request('git.tools', undefined)
    const status = port.request('git.status', { projectPath: t.project })
    await new Promise((r) => setTimeout(r, 20))
    expect(git.calls.filter((c) => c.startsWith('retain') || c.startsWith('status'))).toEqual([])
    expect(git.calls).not.toContain('tools')
    resolved.shift()?.()
    await Promise.all([tools, status])
    const first = git.calls.indexOf('setEnvironment')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(git.calls.findIndex((c) => c.startsWith('retain'))).toBeGreaterThan(first)
    expect(git.calls.indexOf('tools')).toBeGreaterThan(first)

    const reload = port.request('agents.reloadEnvironment', undefined)
    await new Promise((r) => setTimeout(r, 20))
    resolved.shift()?.()
    await reload
    expect(git.calls).toContain('reloadTools')
  })

  it('does not keep a project live for a port that closed while it waited', async () => {
    const git = fakeGit()
    let resolveEnv!: () => void
    const { t, port } = await setup({
      git: git.service,
      resolveEnv: ({ baseEnv }) =>
        new Promise((resolve) => {
          resolveEnv = () =>
            resolve({
              env: baseEnv,
              source: 'login-shell',
              shell: 'zsh',
              durationMs: 1,
              warning: null,
            })
        }),
    })
    await port.request('projects.add', { path: t.project })
    const other = t.connect()
    // A closed port never gets its answer, so the request is left pending.
    void other.request('git.status', { projectPath: t.project }).catch(() => null)
    await new Promise((r) => setTimeout(r, 20))
    other.disconnect()
    resolveEnv()
    await port.request('agents.list', undefined)
    await new Promise((r) => setTimeout(r, 20))
    expect(git.calls.some((c) => c.startsWith('retain'))).toBe(false)
  })

  it('keeps projects live per port and forwards changes to those ports only', async () => {
    const git = fakeGit()
    const { t, port } = await setup({ git: git.service })
    const other = t.connect()
    expect(git.calls).toContain('setBackgroundFetch false')
    await port.request('agents.list', undefined)
    // The resolved environment reaches git once the shell has answered.
    expect(git.calls).toContain('setEnvironment')
    // Git runs in registered projects and scratch folders only.
    const elsewhere = { projectPath: path.dirname(t.project) }
    for (const method of ['git.status', 'git.fetch', 'git.currentPullRequest'] as const) {
      await expect(port.request(method, elsewhere)).rejects.toMatchObject({ code: 'not_found' })
    }
    await port.request('projects.add', { path: t.project })
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
    // Writes and on-demand reads act on registered projects only.
    const target = { remote: 'origin', branch: 'main' }
    await expect(
      port.request('git.push', { projectPath: path.dirname(t.project), ...target }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      port.request('git.push', { projectPath: t.project, ...target }),
    ).resolves.toMatchObject({ log: 'pushed' })
    expect(git.calls).toContain(`push ${t.project} origin/main`)
    expect(git.calls.filter((c) => c.startsWith('push '))).toHaveLength(1)
    await port.request('git.unwatch', { projectPath: t.project })
    expect(git.calls).toContainEqual(expect.stringMatching(/^release .* port-1$/))
    await other.request('git.status', { projectPath: t.project })
    other.disconnect()
    expect(git.calls).toContain('releaseAll port-2')

    await t.host.updateSettings({
      locale: 'en',
      agents: {},
      addedAgents: [],
      proxy: { mode: 'environment' },
      git: { backgroundFetch: true },
      mcp: DEFAULT_SETTINGS.mcp,
      usage: { fromComputer: false },
      sessionTitles: true,
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

describe('project files', () => {
  it('serves the files of a registered project only', async () => {
    const { t, port } = await setup()
    await mkdir(path.join(t.project, 'src'), { recursive: true })
    await writeFile(path.join(t.project, 'src', 'a.txt'), 'Needle in a haystack\n')
    await expect(port.request('files.list', { projectPath: t.project })).rejects.toMatchObject({
      code: 'not_found',
    })

    await port.request('projects.add', { path: t.project })
    expect(await port.request('files.list', { projectPath: t.project })).toEqual({
      paths: ['src/a.txt'],
      truncated: false,
    })
    expect(
      await port.request('files.read', { projectPath: t.project, path: 'src/a.txt' }),
    ).toMatchObject({ kind: 'text', text: 'Needle in a haystack\n' })
    expect(await port.request('files.search', { projectPath: t.project, query: 'needle' })).toEqual(
      {
        matches: [{ path: 'src/a.txt', line: 1, text: 'Needle in a haystack' }],
        truncated: false,
      },
    )
    await expect(
      port.request('files.read', { projectPath: t.project, path: '../outside.txt' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('media', () => {
  it('grants an image outside the project once the thread names it, until the session goes', async () => {
    const { t, port } = await setup()
    await port.request('projects.add', { path: t.project })
    const outside = path.join(t.dir, 'elsewhere', 'a shot.png')
    await mkdir(path.dirname(outside), { recursive: true })
    await writeFile(outside, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    await port.open(created.id)
    const open = () =>
      port.request('media.open', { projectPath: t.project, path: outside, sessionId: created.id })

    expect(await open()).toEqual({ kind: 'forbidden' })
    await port.request('sessions.prompt', {
      sessionId: created.id,
      content: [{ type: 'text', text: `Look at ${outside}` }],
    })
    expect(await open()).toMatchObject({ kind: 'granted', grant: { mimeType: 'image/png' } })
    expect(t.sent).toContainEqual({
      type: 'host:media-grant',
      grant: expect.objectContaining({ path: await realpath(outside), sessionId: created.id }),
    })

    await port.request('sessions.delete', { sessionId: created.id })
    expect(t.sent).toContainEqual({ type: 'host:media-revoke', sessionId: created.id })
  })

  it("finds a file for a device's remote host as media.open checks it, granting main nothing", async () => {
    const { t, port: window } = await setup()
    await window.request('projects.add', { path: t.project })
    const device = t.connect({ id: 'a'.repeat(32), name: 'Phone' })
    const file = path.join(t.project, 'shot.png')
    await writeFile(file, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    const created = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    const params = { projectPath: t.project, path: 'shot.png', sessionId: created.id }
    expect(await device.request('media.authorize', params)).toEqual({
      kind: 'granted',
      file: {
        path: await realpath(file),
        name: 'shot.png',
        kind: 'image',
        mimeType: 'image/png',
        size: 8,
      },
    })
    const outside = path.join(t.dir, 'outside.png')
    await writeFile(outside, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    expect(await device.request('media.authorize', { ...params, path: outside })).toEqual({
      kind: 'forbidden',
    })
    expect(t.sent.some((message) => message.type === 'host:media-grant')).toBe(false)
    // A window has the media scheme instead.
    await expect(window.request('media.authorize', params)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('authorizes a file in the project for a device without a session, and nothing outside', async () => {
    const { t, port: window } = await setup()
    await window.request('projects.add', { path: t.project })
    const device = t.connect({ id: 'a'.repeat(32), name: 'Phone' })
    const file = path.join(t.project, 'shot.png')
    await writeFile(file, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    const outside = path.join(t.dir, 'outside.png')
    await writeFile(outside, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    const authorize = (written: string) =>
      device.request('media.authorize', { projectPath: t.project, path: written })
    expect(await authorize('shot.png')).toMatchObject({
      kind: 'granted',
      file: { path: await realpath(file), mimeType: 'image/png' },
    })
    expect(await authorize(file)).toMatchObject({ kind: 'granted' })
    expect(await authorize(outside)).toEqual({ kind: 'forbidden' })
    expect(await authorize('missing.png')).toEqual({ kind: 'not_found' })
    expect(t.sent.some((message) => message.type === 'host:media-grant')).toBe(false)
  })

  it("describes a media file to a device's files.read and grants main nothing", async () => {
    const { t, port: window } = await setup()
    await window.request('projects.add', { path: t.project })
    const device = t.connect({ id: 'a'.repeat(32), name: 'Phone' })
    await writeFile(path.join(t.project, 'shot.png'), Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    const params = { projectPath: t.project, path: 'shot.png' }
    expect(await device.request('files.read', params)).toEqual({
      kind: 'media',
      path: 'shot.png',
      media: { name: 'shot.png', kind: 'image', mimeType: 'image/png', size: 8 },
    })
    expect(t.sent.some((message) => message.type === 'host:media-grant')).toBe(false)
    // A window's read still has its grant on the media scheme.
    expect(await window.request('files.read', params)).toMatchObject({
      kind: 'media',
      grant: { kind: 'image', mimeType: 'image/png', url: expect.stringContaining('/shot.png') },
    })
    expect(t.sent.filter((message) => message.type === 'host:media-grant')).toHaveLength(1)
  })
})

describe('mentioned files', () => {
  it("adds a registered project's file or folder, and nothing outside it", async () => {
    const { t, port } = await setup()
    await mkdir(path.join(t.project, 'src'), { recursive: true })
    await writeFile(path.join(t.project, 'src', 'a.txt'), 'x')
    await writeFile(path.join(t.dir, 'outside.txt'), 'secret')
    const mention = (file: string) =>
      port.request('attachments.add', {
        source: { projectPath: t.project, path: file },
        thumb: null,
      })
    await expect(mention('src/a.txt')).rejects.toMatchObject({ code: 'not_found' })

    await port.request('projects.add', { path: t.project })
    expect(await mention('src/a.txt')).toMatchObject({
      type: 'file',
      name: 'a.txt',
      uri: pathToFileURL(path.join(t.project, 'src', 'a.txt')).href,
      mimeType: 'text/plain',
      size: 1,
    })
    expect(await mention('src')).toMatchObject({ type: 'folder', name: 'src', size: null })
    await expect(
      mention(path.relative(t.project, path.join(t.dir, 'outside.txt'))),
    ).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(mention('gone.txt')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('sessions without a project', () => {
  const create = (port: ReturnType<TestHost['connect']>, params: object) =>
    port.request('sessions.create', { agentId: 'fake-agent', projectPath: null, ...params })

  it('runs each in a scratch folder of its own, outside the projects', async () => {
    const { t, port } = await setup()
    const summary = await create(port, {})
    expect(summary.scratch).toBe(true)
    expect(path.dirname(summary.projectPath)).toBe(path.join(await realpath(t.dir), 'scratch'))
    expect(path.basename(summary.projectPath)).toMatch(/^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/)
    expect(await readdir(summary.projectPath)).toEqual([])
    expect(await port.request('projects.list', undefined)).toEqual([])
    expect(t.sent).toContainEqual({ type: 'host:projects', paths: [summary.projectPath] })
    expect(await port.request('files.list', { projectPath: summary.projectPath })).toEqual({
      paths: [],
      truncated: false,
    })

    const second = await create(port, {})
    expect(second.projectPath).not.toBe(summary.projectPath)
    const inProject = await create(port, { projectPath: t.project })
    expect(inProject.scratch).toBe(false)
  })

  it("keeps sub-sessions in their parent's folder", async () => {
    const { port } = await setup()
    const parent = await create(port, {})
    const child = await create(port, { projectPath: parent.projectPath, parentId: parent.id })
    expect(child).toMatchObject({
      projectPath: parent.projectPath,
      scratch: true,
      parentId: parent.id,
    })
    expect(await port.request('projects.list', undefined)).toEqual([])
    await expect(create(port, { parentId: parent.id })).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})

describe('artifacts', () => {
  it("reports Kettu's server and where each agent keeps its own, in catalog order", async () => {
    const { t, port } = await setup()
    const status = await port.request('mcp.status', undefined)
    expect(status.servers).toEqual([
      {
        name: 'kettu',
        title: 'Kettu',
        builtIn: true,
        running: true,
        error: null,
        tools: t.host.artifactService.toolSummaries(),
      },
    ])
    // Seven artifact tools, six session tools and the fourteen browser tools.
    expect(status.servers[0]!.tools.length).toBe(27)
    expect(status.places.map((place) => [place.agentId, place.project, place.listCommand])).toEqual(
      [
        ['claude-code', '.mcp.json', null],
        ['codex', '.codex/config.toml', '/mcp'],
        ['opencode', 'opencode.json', null],
      ],
    )
    for (const place of status.places) {
      expect(path.isAbsolute(place.path)).toBe(true)
      expect(place.chosen).toBe(false)
    }
  })

  it('listens again, and sends main the new port', async () => {
    const { t, port } = await setup()
    await t.host.artifactService.stop()
    expect((await port.request('mcp.status', undefined)).servers[0]).toMatchObject({
      running: false,
    })
    port.events.length = 0
    t.sent.length = 0
    const status = await port.request('mcp.retry', undefined)
    expect(status.servers[0]).toMatchObject({ running: true, error: null })
    expect(t.sent.at(-1)).toEqual({
      type: 'host:service-port',
      port: t.host.artifactService.listeningPort,
    })
  })

  it('serves the interface over the port, with its events', async () => {
    const { t, port } = await setup()
    const other = t.connect()
    const { id } = await t.host.artifacts.create({
      project: t.project,
      sessionId: 's1',
      title: 'Report',
      html: '<p>one</p>',
      pages: 1,
      note: null,
    })
    await t.host.artifacts.write({
      id,
      baseVersion: 1,
      html: '<p>two</p>',
      pages: 1,
      author: 's1',
      note: 'Second',
    })
    expect(await port.request('artifacts.list', {})).toEqual([
      expect.objectContaining({ id, title: 'Report', version: 2, editing: [], scratch: false }),
    ])
    expect(await port.request('artifacts.read', { id, version: 1 })).toEqual({
      title: 'Report',
      version: 1,
      html: '<p>one</p>',
    })
    expect(await port.request('artifacts.versions', { id })).toEqual([
      { version: 2, createdAt: expect.any(Number), author: 's1', note: 'Second', size: 10 },
      { version: 1, createdAt: expect.any(Number), author: 's1', note: null, size: 10 },
    ])

    await port.request('artifacts.watch', { id })
    await other.request('artifacts.watch', { id })
    expect(other.events.filter((e) => e.type === 'artifacts.activity').at(-1)).toEqual({
      type: 'artifacts.activity',
      id,
      viewers: 2,
      sessions: [],
    })
    await expect(
      port.request('artifacts.restoreVersion', { id, version: 1, baseVersion: 1 }),
    ).rejects.toMatchObject({ code: 'conflict', data: { version: 2, deleted: false } })
    expect(
      await port.request('artifacts.restoreVersion', { id, version: 1, baseVersion: 2 }),
    ).toEqual({ version: 3 })
    for (const watcher of [port, other]) {
      expect(watcher.events).toContainEqual({ type: 'artifacts.version', id, version: 3 })
    }
    other.disconnect()
    await port.request('artifacts.rename', { id, title: 'Traffic report' })
    expect(port.events.filter((e) => e.type === 'artifacts.activity').at(-1)).toMatchObject({
      viewers: 1,
    })

    await expect(port.request('artifacts.delete', { id, permanently: true })).rejects.toMatchObject(
      { code: 'conflict', data: { version: 3, deleted: false } },
    )
    await port.request('artifacts.delete', { id })
    expect(await port.request('artifacts.list', {})).toEqual([])
    expect(await port.request('artifacts.list', { deleted: true })).toEqual([
      expect.objectContaining({ id, title: 'Traffic report', deletedAt: expect.any(Number) }),
    ])
    await port.request('artifacts.undelete', { id })
    await port.request('artifacts.delete', { id })
    await port.request('artifacts.delete', { id, permanently: true })
    expect(await port.request('artifacts.list', { deleted: true })).toEqual([])
    await expect(port.request('artifacts.read', { id })).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(port.events.filter((e) => e.type === 'artifacts.changed')).toHaveLength(8)
    expect(await readdir(path.join(t.dir, 'artifacts', 'content'))).toEqual([])
  })

  it("names a version's file for main's protocol, or says there is none", async () => {
    const { t } = await setup()
    const { id } = await t.host.artifacts.create({
      project: t.project,
      sessionId: 's1',
      title: 'Report',
      html: '<p>one</p>',
      pages: 1,
      note: null,
    })
    const answers = () => t.sent.filter((message) => message.type === 'host:artifact-content')
    await t.host.artifactContent(1, id, null)
    await t.host.artifactContent(2, id, 1)
    await t.host.artifactContent(3, id, 2)
    await t.host.artifactContent(4, 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW', null)
    const contentDir = path.join(t.dir, 'artifacts', 'content')
    expect(answers()).toEqual([
      {
        type: 'host:artifact-content',
        requestId: 1,
        result: {
          kind: 'found',
          path: expect.stringContaining(contentDir),
          version: 1,
          title: 'Report',
        },
      },
      expect.objectContaining({ requestId: 2, result: expect.objectContaining({ version: 1 }) }),
      { type: 'host:artifact-content', requestId: 3, result: { kind: 'not_found' } },
      { type: 'host:artifact-content', requestId: 4, result: { kind: 'not_found' } },
    ])
  })

  it('lists every artifact it has for main, Recently deleted included', async () => {
    const { t } = await setup()
    const make = (title: string) =>
      t.host.artifacts.create({
        project: t.project,
        sessionId: 's1',
        title,
        html: `<p>${title}</p>`,
        pages: 1,
        note: null,
      })
    const kept = await make('Kept')
    const deleted = await make('Deleted')
    const erased = await make('Erased')
    await t.host.artifacts.delete(deleted.id)
    await t.host.artifacts.delete(erased.id)
    await t.host.artifacts.erase(erased.id)

    await t.host.artifactList(7)
    const answers = t.sent.flatMap((message) =>
      message.type === 'host:artifact-list' ? [message] : [],
    )
    expect(answers).toHaveLength(1)
    const [answer] = answers
    expect(answer?.requestId).toBe(7)
    const ids = answer?.result.kind === 'listed' ? [...answer.result.ids].sort() : null
    expect(ids).toEqual([kept.id, deleted.id].sort())
  })

  it('imports a file the user chose as version 1 by the user, in a project or No project', async () => {
    const { t, port } = await setup()
    await port.request('projects.add', { path: t.project })
    const file = path.join(t.dir, 'Plan v2.html')
    const html = '<title>Roadmap</title><section data-page="A"></section><section data-page="B">'
    await writeFile(file, html)
    const big = path.join(t.dir, 'big.html')
    await writeFile(big, 'x'.repeat(5 * 1024 * 1024 + 1))
    const answers = () =>
      t.sent.flatMap((message) => (message.type === 'host:artifact-import' ? [message] : []))

    await t.host.artifactImport(1, file, t.project)
    await t.host.artifactImport(2, file, null)
    await t.host.artifactImport(3, big, t.project)
    await t.host.artifactImport(4, path.join(t.dir, 'missing.html'), t.project)
    await t.host.artifactImport(5, file, path.join(t.dir, 'other-folder'))
    const ids = answers().flatMap(({ result }) => ('id' in result ? [result.id] : []))
    expect(ids).toHaveLength(2)
    const [first = '', second = ''] = ids
    expect(answers().slice(2)).toEqual([
      { type: 'host:artifact-import', requestId: 3, result: { failed: 'too_large' } },
      { type: 'host:artifact-import', requestId: 4, result: { failed: 'unreadable' } },
      { type: 'host:artifact-import', requestId: 5, result: { failed: 'unavailable' } },
    ])
    expect(first).toMatch(ARTIFACT_ID)
    expect(second).toMatch(ARTIFACT_ID)

    const listed = await port.request('artifacts.list', {})
    expect(listed).toHaveLength(2)
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: first,
        title: 'Roadmap',
        project: t.project,
        scratch: false,
        sessionId: NO_SESSION,
        version: 1,
        pages: 2,
      }),
    )
    expect(listed).toContainEqual(
      expect.objectContaining({ id: second, scratch: true, sessionId: NO_SESSION }),
    )
    expect(await port.request('artifacts.versions', { id: first })).toEqual([
      { version: 1, createdAt: expect.any(Number), author: null, note: null, size: html.length },
    ])
    expect(await port.request('artifacts.read', { id: first })).toMatchObject({ html })
    expect(port.events.some((e) => e.type === 'artifacts.changed')).toBe(true)
  })

  it('keeps the artifacts of a deleted session', async () => {
    const { t, port } = await setup()
    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    const { id } = await t.host.artifacts.create({
      project: session.projectPath,
      sessionId: session.id,
      title: 'Report',
      html: '<p>one</p>',
      pages: 1,
      note: null,
    })
    await port.request('sessions.delete', { sessionId: session.id })
    expect(await port.request('artifacts.list', {})).toEqual([
      expect.objectContaining({ id, sessionId: session.id, project: t.project }),
    ])
  })

  it('marks the artifacts of No project, whether or not their session is still there', async () => {
    const { t, port } = await setup()
    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: null,
    })
    const { id } = await t.host.artifacts.create({
      project: session.projectPath,
      sessionId: session.id,
      title: 'Sketch',
      html: '<p>one</p>',
      pages: 1,
      note: null,
    })
    expect(await port.request('artifacts.list', {})).toEqual([
      expect.objectContaining({ id, project: session.projectPath, scratch: true }),
    ])
    await port.request('sessions.delete', { sessionId: session.id })
    expect(await port.request('artifacts.list', {})).toEqual([
      expect.objectContaining({ id, scratch: true }),
    ])
  })
})

describe('browser calls', () => {
  it('sends a call to main and answers it by its id', async () => {
    const { t } = await setup()
    const answered = t.host.browserCall({
      callId: 1,
      sessionId: 's1',
      tool: 'browser_snapshot',
      args: {},
      projectPath: '/tmp/project',
    })
    const sent = t.sent.find((message) => message.type === 'host:browser-call')
    expect(sent).toMatchObject({
      type: 'host:browser-call',
      sessionId: 's1',
      tool: 'browser_snapshot',
      args: {},
    })
    const callId = (sent as { callId: number }).callId
    t.host.browserResult(
      callId,
      { text: 'Snapshotted the page.', value: { url: 'http://localhost/', snapshot: '- page' } },
      undefined,
    )
    expect(await answered).toEqual({
      result: {
        text: 'Snapshotted the page.',
        value: { url: 'http://localhost/', snapshot: '- page' },
      },
    })
  })

  it('answers a refusal by its code, and ignores an answer to no call', async () => {
    const { t } = await setup()
    const answered = t.host.browserCall({
      callId: 1,
      sessionId: 's1',
      tool: 'browser_click',
      args: { ref: 'e1' },
      projectPath: '/tmp/project',
    })
    const callId = (
      t.sent.find((message) => message.type === 'host:browser-call') as {
        callId: number
      }
    ).callId
    t.host.browserResult(callId + 99, { text: 'late', value: {} }, undefined)
    t.host.browserResult(callId, undefined, {
      code: 'stale_ref',
      message: 'Ref e1 is no longer on the page. Take a new snapshot.',
    })
    expect(await answered).toEqual({
      error: {
        code: 'stale_ref',
        message: 'Ref e1 is no longer on the page. Take a new snapshot.',
      },
    })
  })

  it('fails a call left waiting when the host stops', async () => {
    const { t } = await setup()
    const answered = t.host.browserCall({
      callId: 1,
      sessionId: 's1',
      tool: 'browser_snapshot',
      args: {},
      projectPath: '/tmp/project',
    })
    await t.host.shutdown()
    expect(await answered).toMatchObject({ error: { code: 'timeout' } })
  })

  describe('of a turn another computer sent', () => {
    const laptop = { id: 'b'.repeat(32), name: 'Laptop', browser: true as const }
    const phone = { id: 'a'.repeat(32), name: 'Phone' }
    const quick = () => setup({ agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' } })

    /** A session whose first turn `device` sent, once that turn has ended. */
    async function sentFrom(t: TestHost, window: TestPort, device: TestPort) {
      const created = await device.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: t.project,
        prompt: [{ type: 'text', text: 'Open the app' }],
      })
      await window.untilStatus(created.id, 'ready')
      return created.id
    }

    const browserCalls = (port: TestPort) =>
      port.events.flatMap((event) => (event.type === 'browser.call' ? [event.call] : []))

    it('go to the desktop app that sent it, which answers them', async () => {
      const { t, port: window } = await quick()
      const app = t.connect(laptop)
      const sessionId = await sentFrom(t, window, app)
      const answered = t.host.browserCall({
        callId: 11,
        sessionId,
        tool: 'browser_navigate',
        args: { url: 'http://localhost:5173/' },
        projectPath: t.project,
      })
      await app.until(() => browserCalls(app).length === 1)
      expect(browserCalls(app)[0]).toEqual({
        callId: 11,
        sessionId,
        tool: 'browser_navigate',
        args: { url: 'http://localhost:5173/' },
        projectPath: t.project,
        forward: { host: 'localhost', port: 5173 },
      })
      expect(t.sent.some((message) => message.type === 'host:browser-call')).toBe(false)
      // Only the app's own port answers it.
      await expect(
        window.request('browser.answer', {
          callId: 11,
          answer: { result: { text: 'no', value: {} } },
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      await app.request('browser.waiting', { callId: 11, waiting: true })
      await app.request('browser.answer', {
        callId: 11,
        answer: { result: { text: 'Opened the page.', value: { url: 'http://localhost:5173/' } } },
      })
      expect(await answered).toEqual({
        result: { text: 'Opened the page.', value: { url: 'http://localhost:5173/' } },
      })
      await expect(
        app.request('browser.answer', {
          callId: 11,
          answer: { result: { text: 'again', value: {} } },
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('stay with main for a phone’s turn, and are unavailable once the app is gone', async () => {
      const { t, port: window } = await quick()
      const fromPhone = await sentFrom(t, window, t.connect(phone))
      void t.host.browserCall({
        callId: 12,
        sessionId: fromPhone,
        tool: 'browser_snapshot',
        args: {},
        projectPath: t.project,
      })
      expect(t.sent).toContainEqual(
        expect.objectContaining({ type: 'host:browser-call', callId: 12 }),
      )

      const app = t.connect(laptop)
      const fromApp = await sentFrom(t, window, app)
      const waiting = t.host.browserCall({
        callId: 13,
        sessionId: fromApp,
        tool: 'browser_snapshot',
        args: {},
        projectPath: t.project,
      })
      await app.until(() => browserCalls(app).length === 1)
      app.disconnect()
      expect(await waiting).toMatchObject({ error: { code: 'unavailable' } })
      expect(
        await t.host.browserCall({
          callId: 14,
          sessionId: fromApp,
          tool: 'browser_snapshot',
          args: {},
          projectPath: t.project,
        }),
      ).toMatchObject({ error: { code: 'unavailable' } })

      // The same app back on a new port takes them again.
      const again = t.connect(laptop)
      void t.host.browserCall({
        callId: 15,
        sessionId: fromApp,
        tool: 'browser_snapshot',
        args: {},
        projectPath: t.project,
      })
      await again.until(() => browserCalls(again).length === 1)
    })

    it('ask for a new site in the thread for the app, until it answers or goes', async () => {
      const { t, port: window } = await quick()
      const app = t.connect(laptop)
      const sessionId = await sentFrom(t, window, app)
      await window.open(sessionId)
      const decision = (requestId: number) => {
        const entry = window
          .entries(sessionId)
          .find((each) => each.kind === 'browser_origin' && each.requestId === requestId)
        return entry?.kind === 'browser_origin' ? entry.decision : undefined
      }
      await expect(
        t.connect(phone).request('browser.origin', {
          sessionId,
          requestId: 1,
          origin: 'https://example.com',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })

      // Main numbers its own requests, so the app's may have the same id.
      t.host.browserOriginAsked(1, sessionId, 'https://main.example')
      await app.request('browser.origin', {
        sessionId,
        requestId: 1,
        origin: 'https://example.com',
      })
      await window.until(() => window.summary(sessionId)?.permissionCount === 2)
      await app.request('browser.originSettled', { requestId: 1, decision: 'session' })
      await window.until(() => window.summary(sessionId)?.permissionCount === 1)
      expect(window.entries(sessionId).filter((entry) => entry.kind === 'browser_origin')).toEqual([
        expect.objectContaining({ origin: 'https://main.example', decision: null }),
        expect.objectContaining({ origin: 'https://example.com', decision: 'session' }),
      ])

      await app.request('browser.origin', { sessionId, requestId: 2, origin: 'https://b.example' })
      await window.until(() => decision(2) === null)
      app.disconnect()
      await window.until(() => decision(2) === 'timeout')
    })

    /** The card of the new site `requestId` asks for, once the window shows it. */
    async function originCard(window: TestPort, sessionId: string, requestId: number) {
      const find = () =>
        window
          .entries(sessionId)
          .find((each) => each.kind === 'browser_origin' && each.requestId === requestId)
      await window.until(() => find() !== undefined)
      return () => find() as Extract<ThreadEntry, { kind: 'browser_origin' }>
    }

    it('take a new site’s answer from any client, the first counting, for main’s page', async () => {
      const { t, port: window } = await quick()
      const device = t.connect(phone)
      const sessionId = await sentFrom(t, window, device)
      await window.open(sessionId)
      t.host.browserOriginAsked(7, sessionId, 'https://main.example')
      const card = await originCard(window, sessionId, 7)
      const entryId = card().id

      await expect(
        device.request('browser.answerOrigin', {
          sessionId,
          entryId,
          decision: 'timeout' as never,
        }),
      ).rejects.toMatchObject({ code: 'invalid_params' })
      await expect(
        device.request('browser.answerOrigin', { sessionId, entryId: 'e0', decision: 'deny' }),
      ).rejects.toMatchObject({ code: 'not_found' })

      await device.request('browser.answerOrigin', { sessionId, entryId, decision: 'session' })
      expect(t.sent).toContainEqual({
        type: 'host:browser-origin-decide',
        sessionId,
        requestId: 7,
        decision: 'session',
      })
      // Main has not settled it yet, and still a second answer is too late.
      await expect(
        window.request('browser.answerOrigin', { sessionId, entryId, decision: 'deny' }),
      ).rejects.toMatchObject({
        code: 'not_found',
        data: { reason: 'already_answered', device: { id: phone.id, name: phone.name } },
      })
      t.host.browserOriginSettled(7, 'session')
      await window.until(() => card().decision === 'session')
      expect(card().device).toEqual({ id: phone.id, name: phone.name })
      await expect(
        window.request('browser.answerOrigin', { sessionId, entryId, decision: 'deny' }),
      ).rejects.toMatchObject({ data: { reason: 'already_answered', device: phone } })

      // The window's answer is unlabelled, and so is the one main's pane gave.
      t.host.browserOriginAsked(8, sessionId, 'https://b.example')
      const second = await originCard(window, sessionId, 8)
      await window.request('browser.answerOrigin', {
        sessionId,
        entryId: second().id,
        decision: 'deny',
      })
      t.host.browserOriginSettled(8, 'deny')
      await window.until(() => second().decision === 'deny')
      expect(second().device).toBeUndefined()
      await expect(
        device.request('browser.answerOrigin', {
          sessionId,
          entryId: second().id,
          decision: 'session',
        }),
      ).rejects.toMatchObject({ data: { reason: 'already_answered', device: null } })
    })

    it('pass a new site’s answer to the desktop app whose page asked', async () => {
      const { t, port: window } = await quick()
      const app = t.connect(laptop)
      const device = t.connect(phone)
      const sessionId = await sentFrom(t, window, app)
      await window.open(sessionId)
      await app.request('browser.origin', { sessionId, requestId: 1, origin: 'https://a.example' })
      const card = await originCard(window, sessionId, 1)
      await window.request('browser.answerOrigin', {
        sessionId,
        entryId: card().id,
        decision: 'deny',
      })
      await app.until(() => app.events.some((event) => event.type === 'browser.originDecided'))
      expect(app.events).toContainEqual({
        type: 'browser.originDecided',
        sessionId,
        requestId: 1,
        decision: 'deny',
      })
      expect(device.events.some((event) => event.type === 'browser.originDecided')).toBe(false)
      expect(t.sent.some((message) => message.type === 'host:browser-origin-decide')).toBe(false)
      await app.request('browser.originSettled', { requestId: 1, decision: 'deny' })
      await window.until(() => card().decision === 'deny')
      expect(card().device).toBeUndefined()

      // The app's own pane answered: the card names the app.
      await app.request('browser.origin', { sessionId, requestId: 2, origin: 'https://b.example' })
      const second = await originCard(window, sessionId, 2)
      await app.request('browser.originSettled', { requestId: 2, decision: 'project' })
      await window.until(() => second().decision === 'project')
      expect(second().device).toEqual({ id: laptop.id, name: laptop.name })
      await expect(
        device.request('browser.answerOrigin', {
          sessionId,
          entryId: second().id,
          decision: 'deny',
        }),
      ).rejects.toMatchObject({
        data: { reason: 'already_answered', device: { id: laptop.id, name: laptop.name } },
      })
    })
  })

  it('names the session whose page a call drives, and none for one Kettu lost', async () => {
    const { t, port } = await setup()
    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(t.host.sessions.browserSession(session.id)).toBe(session.id)
    expect(t.host.sessions.browserSession('unknown')).toBeNull()
  })
})
