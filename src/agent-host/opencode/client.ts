// Drives the user's own OpenCode CLI for its providers, accounts and usage. Every side effect first
// checks the provider and credential against OpenCode's own list, and a key travels on stdin only.

import { randomBytes } from 'node:crypto'
import os from 'node:os'
import type { AgentProvider, AgentProviderAction } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { runProgram, type ProgramOptions, type ProgramRun } from '../adapter-install'
import { getEnv, type Env } from '../find-command'
import {
  failedUsage,
  hasUsageEndpoint,
  mapNativeUsage,
  readProviderUsage,
  unsupportedUsage,
  type ProviderUsage,
} from './provider-usage'

const READ_TIMEOUT = 30_000
const ACTION_TIMEOUT = 30_000

interface Integration {
  id: string
  name: string
  methods: unknown[]
  connections: unknown[]
}

interface StoredCredential {
  integrationID: string
  type: string
  key: string | null
  access: string | null
  active: boolean
  orgID: string | null
  officialServer: boolean
}

type Answer = { kind: 'ok'; value: unknown } | { kind: 'missing' } | { kind: 'error' }

type KeyChoice = { kind: 'key'; key: string } | { kind: 'unsupported' } | { kind: 'error' }

export interface OpenCodeClientOptions {
  program: string
  env: Env
  platform: Platform
  runProgram?(options: ProgramOptions): Promise<ProgramRun>
  /** Injected by tests; the host uses the platform's fetch. */
  fetch?: typeof globalThis.fetch
  now?(): number
  /** Where the CLI runs; the user's home directory by default. */
  cwd?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function failed(run: ProgramRun): boolean {
  return (
    run.error !== undefined || run.timedOut || run.aborted || run.code === null || run.code !== 0
  )
}

function integrationOf(value: unknown): Integration | null {
  const row = record(value)
  const id = text(row?.id)
  const name = text(row?.name)
  if (!id || !name) return null
  return {
    id,
    name,
    methods: list(row?.methods) ?? [],
    connections: list(row?.connections) ?? [],
  }
}

function payloadOf(value: unknown): unknown {
  const root = record(value)
  return root && 'data' in root ? root.data : value
}

const CONSOLE_DEFAULT = 'https://opencode.ai/console'

/** Whether a credential belongs to the official Console, never a custom server, before any secret is sent. */
function officialConsole(metadata: Record<string, unknown> | null): boolean {
  const server = (text(metadata?.server) ?? CONSOLE_DEFAULT).replace(
    /^https:\/\/console\.opencode\.ai(?=\/|$)/,
    CONSOLE_DEFAULT,
  )
  try {
    return new URL(server).origin === 'https://opencode.ai'
  } catch {
    return false
  }
}

function methodLabel(method: Record<string, unknown>): AgentProvider['methods'][number] | null {
  const type = text(method.type)
  switch (type) {
    case 'key':
      return { type: 'key', label: text(method.label) ?? 'API key' }
    case 'oauth':
      return { type: 'oauth', label: text(method.label) ?? 'Sign in' }
    case 'command':
      return { type: 'command', label: text(method.label) ?? 'Sign in' }
    case 'external':
      return { type: 'external', label: text(method.label) ?? 'External account' }
    case 'env': {
      const names = (list(method.names) ?? []).filter((name): name is string => text(name) !== null)
      return { type: 'env', label: names.join(', ') || 'Environment' }
    }
    default:
      return null
  }
}

function accountOf(
  connection: Record<string, unknown>,
  integrationID: string,
  saved: Map<string, StoredCredential> | null,
): AgentProvider['accounts'][number] | null {
  const status = record(connection.status)
  const needsAuth = text(status?.status) === 'needs_auth'
  if (connection.type === 'credential') {
    const id = text(connection.id)
    const method = text(connection.method)
    if (!id || (method !== 'key' && method !== 'oauth' && method !== 'external')) return null
    const stored = saved?.get(id)
    const active = stored && stored.integrationID === integrationID ? { active: stored.active } : {}
    return { id, label: text(connection.label) ?? 'Account', method, needsAuth, ...active }
  }
  if (connection.type === 'env') {
    const name = text(connection.name)
    if (!name) return null
    return { id: null, label: name, method: 'env', needsAuth }
  }
  return null
}

function providerOf(
  integration: Integration,
  usage: ProviderUsage | null,
  saved: Map<string, StoredCredential> | null,
): AgentProvider {
  const methods: AgentProvider['methods'] = []
  for (const item of integration.methods) {
    const method = record(item)
    const mapped = method ? methodLabel(method) : null
    if (mapped) methods.push(mapped)
  }
  const accounts: AgentProvider['accounts'] = []
  for (const item of integration.connections) {
    const connection = record(item)
    const mapped = connection ? accountOf(connection, integration.id, saved) : null
    if (mapped) accounts.push(mapped)
  }
  return {
    id: integration.id,
    name: integration.name,
    methods,
    accounts,
    loginCommand: '',
    usage,
  }
}

export class OpenCodeClient {
  private readonly run: (options: ProgramOptions) => Promise<ProgramRun>
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  private readonly cwd: string

  constructor(private readonly options: OpenCodeClientOptions) {
    this.run = options.runProgram ?? runProgram
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.cwd = options.cwd ?? os.homedir()
  }

  async providers(): Promise<AgentProvider[]> {
    const integrations = await this.listIntegrations()
    const now = this.now()
    const { usage, credentials } = await this.readUsage(integrations, now)
    return integrations.map((integration) =>
      providerOf(integration, usage.get(integration.id) ?? null, credentials),
    )
  }

  async action(input: Omit<AgentProviderAction, 'agentId'>): Promise<void> {
    const providerId = typeof input.providerId === 'string' ? input.providerId : ''
    if (!providerId) throw new Error('OpenCode does not know this provider.')
    const integrations = await this.listIntegrations()
    const provider = integrations.find((integration) => integration.id === providerId)
    if (!provider) throw new Error('OpenCode does not know this provider.')

    if (input.action === 'set-key') {
      await this.setKey(provider, input.key)
      return
    }
    const credentialId = this.credentialId(input.credentialId)
    this.assertOwned(provider, credentialId)
    const path = `/api/credential/${encodeURIComponent(credentialId)}`
    if (input.action === 'logout') {
      const run = await this.runTool(['api', 'delete', path], undefined, ACTION_TIMEOUT)
      if (failed(run)) throw new Error('OpenCode could not remove the account.')
      return
    }
    if (input.action !== 'activate') throw new Error('OpenCode does not know this action.')
    const run = await this.runTool(['api', 'post', `${path}/activate`], undefined, ACTION_TIMEOUT)
    if (failed(run)) throw new Error('OpenCode could not activate the account.')
  }

  private credentialId(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('A credential is required.')
    }
    return value
  }

  private assertOwned(provider: Integration, credentialId: string): void {
    const owned = provider.connections.some((item) => {
      const connection = record(item)
      return connection?.type === 'credential' && connection.id === credentialId
    })
    if (!owned) throw new Error('The credential does not belong to this provider.')
  }

  private async setKey(provider: Integration, value: unknown): Promise<void> {
    const key = typeof value === 'string' ? value : ''
    if (key.trim() === '') throw new Error('A key is required.')
    const hasKey = provider.methods.some((item) => record(item)?.type === 'key')
    if (!hasKey) throw new Error('This provider has no key sign-in.')

    const id = `cred_${randomBytes(12).toString('hex')}`
    const entry = [
      {
        id,
        integrationID: provider.id,
        label: provider.name,
        active: true,
        value: { type: 'key', key },
      },
    ]
    const imported = await this.runTool(['auth', 'import'], JSON.stringify(entry), ACTION_TIMEOUT)
    if (failed(imported)) throw new Error('OpenCode could not save the key.')
    const activated = await this.runTool(
      ['api', 'post', `/api/credential/${encodeURIComponent(id)}/activate`],
      undefined,
      ACTION_TIMEOUT,
    )
    if (failed(activated)) {
      throw new Error('The key was saved, but OpenCode could not activate the account.')
    }
  }

  private async listIntegrations(): Promise<Integration[]> {
    const answer = await this.get('/api/integration')
    if (answer.kind !== 'ok') throw new Error('OpenCode could not list its providers.')
    const root = record(answer.value)
    const data = root ? list(root.data) : list(answer.value)
    if (!data) throw new Error('OpenCode could not list its providers.')
    return data
      .map(integrationOf)
      .filter((integration): integration is Integration => integration !== null)
  }

  private async readUsage(
    integrations: Integration[],
    now: number,
  ): Promise<{
    usage: Map<string, ProviderUsage>
    credentials: Map<string, StoredCredential> | null
  }> {
    const usage = new Map<string, ProviderUsage>()
    let credentials: Map<string, StoredCredential> | null = null
    let unavailable = false
    let loading: Promise<void> | null = null
    const load = async (): Promise<boolean> => {
      if (credentials) return true
      if (unavailable) return false
      loading ??= this.listCredentials()
        .then((saved) => {
          credentials = saved
        })
        .catch(() => {
          unavailable = true
        })
      await loading
      return credentials !== null
    }

    const opencode = integrations.find(
      (integration) => integration.id === 'opencode' && integration.connections.length > 0,
    )
    const opencodeUsage = opencode
      ? this.openCodeUsage(opencode, now, load, () => credentials)
      : null

    const candidates: Integration[] = []
    for (const integration of integrations) {
      if (integration.connections.length === 0 || integration.id === 'opencode') continue
      if (hasUsageEndpoint(integration.id)) candidates.push(integration)
      else usage.set(integration.id, unsupportedUsage(now))
    }
    if (candidates.length > 0) {
      if (candidates.some((integration) => hasCredential(integration))) await load()

      await Promise.all(
        candidates.map(async (integration) => {
          const choice = this.keyFor(integration, credentials, unavailable)
          if (choice.kind === 'error') {
            usage.set(integration.id, failedUsage(now))
            return
          }
          if (choice.kind === 'unsupported') {
            usage.set(integration.id, unsupportedUsage(now))
            return
          }
          usage.set(
            integration.id,
            await readProviderUsage({
              providerId: integration.id,
              key: choice.key,
              now,
              fetch: this.fetchImpl,
            }),
          )
        }),
      )
    }
    if (opencodeUsage) usage.set('opencode', await opencodeUsage)
    return { usage, credentials }
  }

  /**
   * OpenCode 2.0.32 has no usage route, so the Console credentials fall back to
   * the Go endpoint of the official Console origin. 403 means no Go plan, not a
   * failure; 401 and other answers are read as failures. A custom Console
   * server is never sent to the official origin.
   */
  private async openCodeUsage(
    integration: Integration,
    now: number,
    load: () => Promise<boolean>,
    saved: () => Map<string, StoredCredential> | null,
  ): Promise<ProviderUsage> {
    const answer = await this.get('/api/experimental/usage/limits')
    if (answer.kind === 'ok') return mapNativeUsage(payloadOf(answer.value), now)
    if (answer.kind !== 'missing') return failedUsage(now)
    if (!hasCredential(integration)) return unsupportedUsage(now)
    if (!(await load())) return failedUsage(now)
    const access = this.goAccess(integration, saved())
    if (!access) return unsupportedUsage(now)
    return readProviderUsage({
      providerId: 'opencode-go',
      key: access.token,
      now,
      fetch: this.fetchImpl,
      headers: { 'x-opencode-org-id': access.orgID },
      forbidden: 'unsupported',
    })
  }

  private goAccess(
    integration: Integration,
    saved: Map<string, StoredCredential> | null,
  ): { token: string; orgID: string } | null {
    const active = this.selectedCredential(integration, saved)
    if (!active || !active.officialServer || !active.orgID) return null
    const token =
      active.type === 'key' ? active.key : active.type === 'oauth' ? active.access : null
    return token ? { token, orgID: active.orgID } : null
  }

  /** A stored active flag wins; without one, OpenCode's connections are already active-first. */
  private selectedCredential(
    integration: Integration,
    saved: Map<string, StoredCredential> | null,
  ): StoredCredential | null {
    if (!saved) return null
    const stored: StoredCredential[] = []
    for (const item of integration.connections) {
      const connection = record(item)
      if (connection?.type !== 'credential') continue
      const id = text(connection.id)
      if (!id) continue
      const credential = saved.get(id)
      if (credential && credential.integrationID === integration.id) stored.push(credential)
    }
    return stored.find((credential) => credential.active) ?? stored[0] ?? null
  }

  private keyFor(
    integration: Integration,
    saved: Map<string, StoredCredential> | null,
    unavailable: boolean,
  ): KeyChoice {
    const active = this.selectedCredential(integration, saved)
    if (active) {
      if (active.type !== 'key' || !active.key) return { kind: 'unsupported' }
      return { kind: 'key', key: active.key }
    }
    if (saved === null && unavailable && hasCredential(integration)) {
      return { kind: 'error' }
    }
    for (const item of integration.connections) {
      const connection = record(item)
      if (connection?.type !== 'env') continue
      const name = text(connection.name)
      if (!name) continue
      const value = getEnv(this.options.env, name, this.options.platform)
      if (value) return { kind: 'key', key: value }
    }
    return { kind: 'unsupported' }
  }

  private async listCredentials(): Promise<Map<string, StoredCredential>> {
    const answer = await this.get('/api/credential')
    if (answer.kind !== 'ok') throw new Error('OpenCode could not read its credentials.')
    const root = record(answer.value)
    const data = root ? list(root.data) : list(answer.value)
    if (!data) throw new Error('OpenCode could not read its credentials.')
    const credentials = new Map<string, StoredCredential>()
    for (const item of data) {
      const row = record(item)
      const id = text(row?.id)
      const integrationID = text(row?.integrationID)
      const value = record(row?.value)
      const type = text(value?.type)
      if (!id || !integrationID || !type) continue
      const metadata = record(value?.metadata)
      credentials.set(id, {
        integrationID,
        type,
        key: type === 'key' ? text(value?.key) : null,
        access: type === 'oauth' ? text(value?.access) : null,
        active: row?.active === true,
        orgID: text(metadata?.orgID),
        officialServer: officialConsole(metadata),
      })
    }
    return credentials
  }

  private async get(path: string): Promise<Answer> {
    const run = await this.runTool(['api', 'get', path])
    if (run.error !== undefined || run.timedOut || run.aborted) return { kind: 'error' }
    if (run.code !== 0) {
      return /HTTP 404\b/.test(run.output.toString()) ? { kind: 'missing' } : { kind: 'error' }
    }
    try {
      return { kind: 'ok', value: JSON.parse(run.stdout) as unknown }
    } catch {
      return { kind: 'error' }
    }
  }

  private runTool(args: string[], input?: string, timeoutMs = READ_TIMEOUT): Promise<ProgramRun> {
    return this.run({
      program: this.options.program,
      args,
      cwd: this.cwd,
      env: this.options.env,
      platform: this.options.platform,
      timeoutMs,
      input,
    })
  }
}

function hasCredential(integration: Integration): boolean {
  return integration.connections.some((item) => record(item)?.type === 'credential')
}
