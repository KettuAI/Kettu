// End-to-end GLM Agent sign-in detection, API key persistence, terminal `--setup` command
// exposure, and credential refresh behavior inside AgentManager.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { GLM } from './agents/glm'
import type { AgentConnection, AgentInit } from './connection'
import { Diagnostics } from './diagnostics'
import type { ProcessDriver } from './driver'
import { glmCredentialsFile, writeGlmKey } from './glm/credentials'
import { parseRegistry } from './registry'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const GLM_INIT: AgentInit = {
  protocolVersion: 1,
  name: 'glm-acp-agent',
  version: '1.18.0',
  capabilities: {
    loadSession: true,
    listSessions: true,
    resumeSession: true,
    closeSession: true,
    deleteSession: false,
    forkSession: true,
    forkAtMessage: false,
    ownTitles: 'sent',
    logout: false,
    steering: false,
    mcpHttp: true,
    mcpSse: false,
    mcpStdio: true,
    prompt: { image: true, audio: false, embeddedContext: true },
  },
  // Mirrors real glm-acp-agent@1.18.0 `initialize` response after AcpConnection parses it.
  authMethods: [
    {
      id: 'z-ai-api-key',
      name: 'Z.AI API key',
      description: 'Set Z_AI_API_KEY or run glm-acp-agent --setup',
      type: 'agent',
      args: [],
      env: {},
    },
    {
      id: 'z_ai_api_key',
      name: 'Z.AI API key',
      description: 'API key for the Z.AI / Zhipu AI service.',
      type: 'env',
      envVars: [{ name: 'Z_AI_API_KEY', optional: false }],
      args: [],
      env: {},
    },
  ],
  raw: {},
}

function makeSettings(): HostSettings {
  return {
    locale: 'en',
    initialSetupDone: true,
    agents: { glm: { enabled: true } },
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

async function writeInstalledGlm(adaptersDir: string, version = '1.18.0'): Promise<string> {
  const dir = path.join(adaptersDir, 'glm', version)
  const pkgDir = path.join(dir, 'node_modules', 'glm-acp-agent')
  const entry = path.join(pkgDir, 'dist', 'index.js')
  await mkdir(path.dirname(entry), { recursive: true })
  await writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'glm-acp-agent', version, bin: { 'glm-acp-agent': './dist/index.js' } }),
    'utf8',
  )
  await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
  await writeFile(
    path.join(dir, 'installed.json'),
    JSON.stringify({
      package: 'glm-acp-agent',
      version,
      node: null,
      npm: null,
      installedAt: Date.now(),
    }),
    'utf8',
  )
  return entry
}

async function setupManager(
  options: {
    installed?: boolean
    env?: Record<string, string>
    seedFileKey?: string
    hasEnvKey?: () => boolean
  } = {},
) {
  const root = await tempFolder('kettu-glm-sign-in-')
  const xdg = path.join(root, 'xdg')
  const adaptersDir = path.join(root, 'adapters')
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const baseEnv: Record<string, string> = {
    PATH: '',
    HOME: root,
    XDG_CONFIG_HOME: xdg,
    ...(options.env ?? {}),
  }
  const credentialsPath = glmCredentialsFile(baseEnv, root, platform)
  if (options.seedFileKey) {
    await writeGlmKey(credentialsPath, options.seedFileKey)
  }
  const entry = options.installed === false ? null : await writeInstalledGlm(adaptersDir)
  let stops = 0
  let authCommands: string[] = []
  const signedInEvents: string[] = []
  const accountChangedEvents: string[] = []

  const connection = {
    closed: new Promise<void>(() => {}),
    isClosed: false,
    initialize: async () => GLM_INIT,
    authenticate: async () => {},
    logout: async () => {},
    close: () => {},
  } as unknown as AgentConnection
  const driver: ProcessDriver = { kind: 'process', connect: () => connection }

  const nodeRuntime = { command: process.execPath, env: {} }
  const agents = new AgentManager({
    catalog: [GLM],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv,
      resolve: async ({ baseEnv: current }) => ({
        env: current,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({
        nodeVersion: '22.14.0',
        npmPath: '/usr/bin/npm',
        nodePath: process.execPath,
      }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: () => {
        let exit!: () => void
        const exited = new Promise<{ code: number; signal: null }>((resolve) => {
          exit = () => resolve({ code: 0, signal: null })
        })
        return {
          pid: 4242,
          startedAt: Date.now(),
          exited,
          hasExited: false,
          stop: async () => {
            stops++
            exit()
            return { code: 0, signal: null }
          },
          kill: async () => exit(),
          transport: {} as never,
        }
      },
    },
    settings: () => makeSettings(),
    reportsDir: path.join(root, 'reports'),
    adaptersDir,
    bundled: {
      registry: parseRegistry({
        agents: [
          {
            id: 'glm-acp-agent',
            version: '1.18.0',
            distribution: { npx: { package: 'glm-acp-agent@1.18.0' } },
          },
        ],
      })!,
      kettu: new Map(),
      manifest: null,
    },
    drivers: { acp: driver },
    envKeyIsSet: (_agentId, variable) =>
      variable === 'Z_AI_API_KEY' && options.hasEnvKey?.() === true,
    status: () => {},
    processes: () => {},
    authCommands: (commands) => {
      authCommands = commands
    },
  })
  agents.hooks = {
    liveSessions: () => 0,
    agentExited: () => {},
    signedIn: (id) => signedInEvents.push(id),
    accountChanged: (id) => {
      accountChangedEvents.push(id)
    },
    optionsKnown: () => true,
    optionsSeen: () => {},
    configChanged: () => {},
  }

  const glmStatus = async () => (await agents.list()).find((s) => s.id === 'glm')!
  return {
    agents,
    glmStatus,
    credentialsPath,
    entry,
    stops: () => stops,
    authCommands: () => authCommands,
    signedInEvents,
    accountChangedEvents,
  }
}

describe('GLM Agent sign-in in AgentManager', () => {
  it('exposes signed-out status, API key entry, and --setup command before first session', async () => {
    const { glmStatus, entry, authCommands } = await setupManager({ installed: true })
    const status = await glmStatus()

    expect(status.signIn).toBe('required')
    expect(status.account).toBeNull()
    expect(status.apiKey).toEqual({ set: false, providers: false })
    expect(status.capabilities.account).toBe(true)

    const terminal = status.authMethods.find((m) => m.id === 'glm-setup')
    expect(terminal?.type).toBe('terminal')
    expect(terminal?.command).toContain(entry!)
    expect(terminal?.command).toContain('--setup')
    expect(authCommands()).toContain(terminal!.command)

    const keyMethod = status.authMethods.find((m) => m.id === 'glm-api-key')
    expect(keyMethod).toMatchObject({ type: 'env', envVars: [] })
  })

  it('still offers API key sign-in when package is not installed yet without broken terminal command', async () => {
    const { glmStatus, authCommands } = await setupManager({ installed: false })
    const status = await glmStatus()

    expect(status.signIn).toBe('required')
    expect(status.apiKey).toEqual({ set: false, providers: false })
    expect(status.authMethods.some((m) => m.type === 'terminal')).toBe(false)
    expect(status.authMethods.map((m) => m.id)).toEqual(['glm-api-key'])
    expect(authCommands()).toEqual([])
  })

  it('detects existing CLI credentials.json without launching GLM Agent', async () => {
    const { glmStatus } = await setupManager({ seedFileKey: 'cli-existing-key' })
    const status = await glmStatus()

    expect(status.state).toBe('available')
    expect(status.signIn).toBe('signed-in')
    expect(status.apiKey).toEqual({ set: true, providers: false })
    expect(status.account).toEqual({ kind: 'api_key', label: 'Z.AI API key', email: null })
  })

  it('detects existing Z_AI_API_KEY from environment without launching GLM Agent', async () => {
    const { glmStatus } = await setupManager({ env: { Z_AI_API_KEY: 'env-key' } })
    const status = await glmStatus()

    expect(status.signIn).toBe('signed-in')
    expect(status.apiKey).toEqual({ set: false, providers: false })
    expect(status.account).toEqual({ kind: 'api_key', label: 'Z.AI API key', email: null })
  })

  it('writes and clears credentials.json via setApiKey / clearApiKey and refreshes sign-in state', async () => {
    const { agents, glmStatus, credentialsPath, signedInEvents, stops } = await setupManager()
    expect((await glmStatus()).signIn).toBe('required')

    await agents.ensureReady('glm')
    await agents.setApiKey('glm', { key: 'sk-glm-new' })

    expect(JSON.parse(await readFile(credentialsPath, 'utf8'))).toEqual({
      z_ai_api_key: 'sk-glm-new',
    })
    // Stops the idle running process so the next start picks up the new credentials.
    expect(stops()).toBe(1)
    expect(signedInEvents).toEqual(['glm'])

    const afterSet = await glmStatus()
    expect(afterSet.signIn).toBe('signed-in')
    expect(afterSet.apiKey).toEqual({ set: true, providers: false })
    expect(afterSet.account).toEqual({ kind: 'api_key', label: 'Z.AI API key', email: null })

    await agents.clearApiKey('glm')
    await expect(stat(credentialsPath)).rejects.toThrow()

    const afterClear = await glmStatus()
    expect(afterClear.signIn).toBe('required')
    expect(afterClear.apiKey).toEqual({ set: false, providers: false })
    expect(afterClear.account).toBeNull()
  })

  it('stays signed in via env Z_AI_API_KEY after clearing credentials.json', async () => {
    const { agents, glmStatus } = await setupManager({
      env: { Z_AI_API_KEY: 'env-key' },
      seedFileKey: 'file-key',
    })
    expect((await glmStatus()).apiKey?.set).toBe(true)

    await agents.clearApiKey('glm')

    const status = await glmStatus()
    expect(status.signIn).toBe('signed-in')
    expect(status.apiKey).toEqual({ set: false, providers: false })
  })

  it('refreshes state and stops idle process after external terminal --setup completes', async () => {
    const { agents, glmStatus, credentialsPath, signedInEvents, stops } = await setupManager()
    expect((await glmStatus()).signIn).toBe('required')

    await agents.ensureReady('glm')
    // Simulate the user finishing `glm-acp-agent --setup` in the terminal.
    await writeGlmKey(credentialsPath, 'sk-from-setup')

    await agents.refreshAccount('glm', { force: true, afterSignIn: true })

    expect(stops()).toBe(1)
    expect(signedInEvents).toEqual(['glm'])
    const status = await glmStatus()
    expect(status.signIn).toBe('signed-in')
    expect(status.apiKey).toEqual({ set: true, providers: false })
    expect(status.account).toEqual({ kind: 'api_key', label: 'Z.AI API key', email: null })
  })

  it('filters out glm-acp-agent no-op agent method and duplicate env method after initialize', async () => {
    const { agents, glmStatus } = await setupManager()
    await agents.ensureReady('glm')
    const status = await glmStatus()

    expect(status.authMethods.map((m) => m.id)).toEqual(['glm-setup', 'glm-api-key'])
    expect(status.authMethods.some((m) => m.id === 'z-ai-api-key')).toBe(false)
    expect(status.authMethods.some((m) => m.id === 'z_ai_api_key')).toBe(false)
  })

  it('refreshes GLM sign-in state when Kettu-managed Z_AI_API_KEY env changes', async () => {
    let storedEnvKey = false
    const { agents, glmStatus, signedInEvents } = await setupManager({
      hasEnvKey: () => storedEnvKey,
    })
    expect((await glmStatus()).signIn).toBe('required')

    storedEnvKey = true
    await agents.agentEnvChanged('glm')
    expect((await glmStatus()).signIn).toBe('signed-in')
    expect(signedInEvents).toEqual(['glm'])

    storedEnvKey = false
    await agents.agentEnvChanged('glm')
    expect((await glmStatus()).signIn).toBe('required')
  })
})
