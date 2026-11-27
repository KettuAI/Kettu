// agy's ACP mode signs in with the method its last ACP client saved, and refuses every session once
// that method's credentials are gone, though agy still holds a Google sign-in. Kettu then checks
// for that sign-in in a scratch agy and signs the running agy in with it, never opening a browser.

import { access, chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { SessionSummary } from '@shared/agent-host'
import { AgentManager } from './agents'
import { ANTIGRAVITY } from './agents/antigravity'
import type { LaunchSpec } from './catalog'
import { AgentRequestError, type AgentConnection, type AgentInit } from './connection'
import { Diagnostics } from './diagnostics'
import type { ProcessDriver } from './driver'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { EnvironmentService } from './shell-env'
import { returnedFile, sessionsFile } from './storage'
import { FakeAppServer, FakeRpcError } from './testing/fake-app-server'
import { tempFolder } from './testing/temp'
import sessionNew from './vendor-usage/fixtures/agy-session-new.json'

const INIT: AgentInit = {
  protocolVersion: 1,
  name: 'antigravity',
  version: '1.5.17',
  capabilities: {
    loadSession: true,
    listSessions: true,
    resumeSession: true,
    closeSession: true,
    deleteSession: false,
    forkSession: false,
    forkAtMessage: false,
    ownTitles: null,
    logout: true,
    steering: false,
    mcpHttp: true,
    mcpSse: true,
    mcpStdio: true,
    prompt: { image: true, audio: false, embeddedContext: true },
  },
  authMethods: [
    { id: 'oauth-personal', name: 'Sign in with Google', type: 'agent', args: [], env: {} },
    { id: 'gemini-api-key', name: 'Use Gemini API key', type: 'agent', args: [], env: {} },
  ],
  raw: {},
}

function settings(program: string): HostSettings {
  return {
    locale: 'en',
    initialSetupDone: true,
    agents: { antigravity: { enabled: true, binaryPath: program } },
    addedAgents: [],
    disabledAgents: [],
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    marketplace: DEFAULT_SETTINGS.marketplace,
    startModes: DEFAULT_SETTINGS.startModes,
    idleSessions: DEFAULT_SETTINGS.idleSessions,
    workflow: DEFAULT_SETTINGS.workflow,
    startedSessions: DEFAULT_SETTINGS.startedSessions,
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
    downloadService: false,
  }
}

/** A run of the launcher's that never ends on its own. */
function running(transport: unknown = {}) {
  let exit!: () => void
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    exit = () => resolve({ code: 0, signal: null })
  })
  return {
    pid: null,
    startedAt: 0,
    exited,
    hasExited: false,
    stop: async () => {
      exit()
      return { code: 0, signal: null }
    },
    kill: async () => exit(),
    transport: transport as never,
  }
}

/**
 * A manager whose only harness is Antigravity's default agent. Its scratch agy holds a Google
 * sign-in when `holds`, and refuses the session otherwise; signing the running agy in with it
 * hands over a page to open when `opensPage`. The running agy refuses its first session.
 */
async function manager(holds: boolean, { opensPage = false } = {}) {
  const root = await tempFolder('kettu-agy-sign-in-')
  const program = path.join(root, process.platform === 'win32' ? 'agy.cmd' : 'agy')
  await writeFile(program, '')
  await chmod(program, 0o755)
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const authenticated: string[] = []
  const checks: { spec: LaunchSpec; server: FakeAppServer }[] = []
  const opened: string[] = []
  const connection = {
    closed: new Promise<void>(() => {}),
    isClosed: false,
    initialize: async () => INIT,
    authenticate: async (
      methodId: string,
      options: { openLink(url: string): void; signal?: AbortSignal },
    ) => {
      authenticated.push(methodId)
      if (!opensPage) return
      options.openLink('https://accounts.google.com/o/oauth2/auth')
      await new Promise<never>((_, reject) => {
        const cancel = () => reject(new Error('The sign-in was cancelled'))
        if (options.signal?.aborted) cancel()
        else options.signal?.addEventListener('abort', cancel)
      })
    },
    newSession: async (cwd: string) => {
      opened.push(cwd)
      if (opened.length === 1) {
        throw new AgentRequestError('auth_required', 'Authentication required', -32000)
      }
      return { sessionId: `agy-${opened.length}`, config: [] }
    },
    setConfigOption: async () => [],
    register: () => {},
    unregister: () => {},
    close: () => {},
  } as unknown as AgentConnection
  const driver: ProcessDriver = { kind: 'process', connect: () => connection }
  const signedIn: string[] = []
  const agents = new AgentManager({
    catalog: [ANTIGRAVITY],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: { PATH: '', HOME: root },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: (_def, spec) => {
        if (!spec.args.includes('--gemini-dir')) return running()
        const server = new FakeAppServer()
          .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
          .on('session/new', () => {
            if (holds) return sessionNew
            throw new FakeRpcError(-32000, 'Authentication required')
          })
        checks.push({ spec, server })
        return running(server.transport)
      },
    },
    settings: () => settings(program),
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    drivers: { acp: driver },
    probeCli: async () => ({ version: '1.5.17' }),
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  agents.hooks = {
    liveSessions: () => 0,
    agentExited: () => {},
    signedIn: (agentId) => signedIn.push(agentId),
    accountChanged: () => {},
    optionsKnown: () => true,
    optionsSeen: () => {},
    configChanged: () => {},
  }
  const signIn = async () =>
    (await agents.list()).find((status) => status.id === 'antigravity')?.signIn
  return { agents, authenticated, checks, opened, signedIn, signIn, root, program }
}

/** New session's window over `agents`, with the prepared sessions' summaries it is sent. */
async function newSession({ agents, root, program }: Awaited<ReturnType<typeof manager>>) {
  const summaries: SessionSummary[] = []
  const events = new Proxy({} as SessionEvents, {
    get: (_, name) =>
      name === 'summary' ? (summary: SessionSummary) => summaries.push(summary) : () => {},
  })
  const sessions = new SessionManager({
    platform: process.platform === 'win32' ? 'win32' : process.platform,
    agents,
    projects: {
      list: () => [],
      find: () => null,
      resolveDirectory: async (folder: string) => folder,
      add: async () => {},
    } as unknown as Projects,
    scratch: { contains: () => false } as unknown as ScratchFolders,
    file: sessionsFile(root, () => {}),
    returned: returnedFile(root, () => {}),
    portOpen: () => true,
    threads: null,
    reportsDir: path.join(root, 'reports'),
    diagnostics: new Diagnostics(),
    git: () => null,
    events,
    settings: () => settings(program),
  })
  await sessions.load()
  const ready = () => summaries.filter((s) => s.prepared && s.status === 'ready')
  return { sessions, ready }
}

describe('Google Antigravity refusing a session though agy holds a Google sign-in', () => {
  it('signs the running agy in with the Google sign-in a scratch agy shows', async () => {
    const { agents, authenticated, checks, signedIn, signIn, root } = await manager(true)
    await agents.ensureReady('antigravity')

    agents.authRequired('antigravity')

    await vi.waitFor(() => expect(authenticated).toEqual(['oauth-personal']))
    await vi.waitFor(() => expect(signedIn).toEqual(['antigravity']))
    expect(await signIn()).toBe('signed-in')
    expect(checks).toHaveLength(1)
    const [check] = checks
    const flag = check!.spec.args.indexOf('--gemini-dir')
    const folder = path.dirname(check!.spec.args[flag + 1]!)
    expect(path.dirname(folder)).toBe(path.join(root, 'reports'))
    expect(check!.server.sent('session/new')).toEqual([{ cwd: folder, mcpServers: [] }])
    // It never signs in itself.
    expect(check!.server.sent('authenticate')).toEqual([])
    await vi.waitFor(() => expect(access(folder)).rejects.toThrow())
  })

  it('asks for a sign-in when agy holds none, without signing in', async () => {
    const { agents, authenticated, checks, signIn } = await manager(false)
    await agents.ensureReady('antigravity')

    agents.authRequired('antigravity')

    await vi.waitFor(async () => expect(await signIn()).toBe('required'))
    expect(checks).toHaveLength(1)
    expect(authenticated).toEqual([])
  })

  it('opens New session again and reads the plan limits once it signed agy in', async () => {
    const setup = await manager(true)
    const { agents, opened, root } = setup
    const { sessions, ready } = await newSession(setup)
    const limits = vi.spyOn(agents, 'refreshLimits').mockResolvedValue()

    await expect(
      sessions.prepare({ agentId: 'antigravity', projectPath: root }, 'window'),
    ).rejects.toMatchObject({ code: 'auth_required' })

    await vi.waitFor(() => expect(ready()).toHaveLength(1))
    expect(opened).toEqual([root, root])
    expect(limits.mock.calls).toEqual([['antigravity', { force: true }]])
    // The window's next ask takes the one opened for it.
    const again = await sessions.prepare({ agentId: 'antigravity', projectPath: root }, 'window')
    expect(again.id).toBe(ready()[0]!.id)
    expect(opened).toHaveLength(2)
  })

  it.each([
    ['agy holds no Google sign-in', false, false],
    ['signing in would open a page', true, true],
  ])('opens nothing again and reads no limits when %s', async (_, holds, opensPage) => {
    const setup = await manager(holds, { opensPage })
    const { agents, checks, opened, root, signIn } = setup
    const { sessions, ready } = await newSession(setup)
    const limits = vi.spyOn(agents, 'refreshLimits').mockResolvedValue()

    await expect(
      sessions.prepare({ agentId: 'antigravity', projectPath: root }, 'window'),
    ).rejects.toMatchObject({ code: 'auth_required' })

    await vi.waitFor(async () => expect(await signIn()).toBe('required'))
    expect(checks).toHaveLength(1)
    expect(opened).toHaveLength(1)
    expect(ready()).toEqual([])
    expect(limits).not.toHaveBeenCalled()
  })

  it('checks once for each agy process', async () => {
    const { agents, checks, signIn } = await manager(true)
    await agents.ensureReady('antigravity')
    agents.authRequired('antigravity')
    await vi.waitFor(async () => expect(await signIn()).toBe('signed-in'))

    agents.authRequired('antigravity')

    expect(await signIn()).toBe('required')
    expect(checks).toHaveLength(1)
  })
})
