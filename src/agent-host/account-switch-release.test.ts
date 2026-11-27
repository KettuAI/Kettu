// Integration tests for releasing live session connections when an agent's account changes
// (#2832): authenticate, logout, refreshAccount (identity change vs no-op, plus post-terminal
// sign-in), profile isolation (antigravity vs antigravity~work), busy/waitingBackground/permission
// deferred release, queued follow-up reconnection, auth_required retry reconnection, and prepared
// session invalidation.

import path from 'node:path'
import {
  agent,
  methods,
  RequestError,
  type AgentContext,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { inProcessTransport } from './acp/connection'
import type { ExitInfo } from './agent-process'
import type { AgentLauncher } from './agents'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 30_000 })

const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
const SECOND_PROFILE: AgentId = 'antigravity~work'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

interface AuthStateReply {
  state: 'authenticated' | 'unauthenticated' | 'not_required' | 'unknown'
  accounts?: { label: string; email?: string; active?: boolean }[]
}

interface PendingPrompt {
  sessionId: string
  generation: number
  text: string
  client: AgentContext
  resolve: (result: { stopReason: 'end_turn' | 'cancelled' } | Error) => void
}

interface ProfileFixture {
  readonly id: string
  /** Current account reported by auth/status and stamped onto newly spawned session connections. */
  account: string
  authStatus: AuthStateReply
  /** When true, prompts are held until resolved manually via `prompts`. */
  holdPrompts: boolean
  /** When set, any prompt on a session generation bound to this account fails with HTTP 429. */
  quotaExceededAccount: string | null
  /** When set, any prompt on a session generation bound to this account fails with auth_required. */
  authRequiredAccount: string | null
  /** Optional permission request emitted on the next prompt before settling. */
  askPermissionOnNextPrompt: boolean
  readonly prompts: PendingPrompt[]
  readonly closedSessions: { sessionId: string; generation: number }[]
  readonly resumedSessions: { sessionId: string; generation: number; account: string }[]
  readonly openedSessions: { sessionId: string; generation: number; account: string }[]
  readonly cancelledSessions: string[]
  readonly authCalls: string[]
  readonly logoutCalls: number[]
  readonly authStatusCalls: number[]
  /** Account bound to each live sessionId when it was opened or last resumed. */
  readonly sessionAccount: Map<string, string>
  /** Generation counter incremented per new/resumed connection for each sessionId. */
  readonly sessionGeneration: Map<string, number>
}

function createProfileFixture(id: string, initialAccount: string): ProfileFixture {
  return {
    id,
    account: initialAccount,
    authStatus: {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: initialAccount, active: true }],
    },
    holdPrompts: false,
    quotaExceededAccount: null,
    authRequiredAccount: null,
    askPermissionOnNextPrompt: false,
    prompts: [],
    closedSessions: [],
    resumedSessions: [],
    openedSessions: [],
    cancelledSessions: [],
    authCalls: [],
    logoutCalls: [],
    authStatusCalls: [],
    sessionAccount: new Map(),
    sessionGeneration: new Map(),
  }
}

function buildAgentApp(fixture: ProfileFixture, options?: { authStatus?: boolean }) {
  let seq = 0
  const activePrompts = new Map<string, PendingPrompt>()

  const notify = (sessionId: string, client: AgentContext, value: object) =>
    client.notify(methods.client.session.update, {
      sessionId,
      update: value as SessionUpdate,
    })

  const app = agent({ name: `scripted-${fixture.id}` })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {} },
        auth: {
          logout: {},
          ...(options?.authStatus !== false ? { status: {} } : {}),
        },
      },
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' },
      authMethods: [
        { id: 'oauth-personal', name: 'Sign in with Google' },
        { id: 'oauth-business', name: 'Sign in with Gemini Enterprise' },
      ],
    }))
    .onRequest(methods.agent.auth.status, () => {
      fixture.authStatusCalls.push(Date.now())
      return fixture.authStatus as never
    })
    .onRequest(methods.agent.authenticate, (ctx) => {
      fixture.authCalls.push(ctx.params.methodId)
      return {
        _meta: {
          antigravity: {
            tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: '' },
          },
        },
      }
    })
    .onRequest(methods.agent.logout, () => {
      fixture.logoutCalls.push(Date.now())
      fixture.authStatus = { state: 'unauthenticated', accounts: [] }
      return {}
    })
    .onRequest(methods.agent.session.new, () => {
      const sessionId = `${fixture.id}-s-${++seq}`
      const generation = (fixture.sessionGeneration.get(sessionId) ?? 0) + 1
      fixture.sessionGeneration.set(sessionId, generation)
      // Simulate agy acp caching the keyring account once when the session process spawns.
      fixture.sessionAccount.set(sessionId, fixture.account)
      fixture.openedSessions.push({ sessionId, generation, account: fixture.account })
      return {
        sessionId,
        _meta: {
          antigravity: {
            tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: '' },
          },
        },
      }
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      const { sessionId } = ctx.params
      const generation = (fixture.sessionGeneration.get(sessionId) ?? 0) + 1
      fixture.sessionGeneration.set(sessionId, generation)
      // Resuming spawns a fresh per-session process that reads the current keyring account.
      fixture.sessionAccount.set(sessionId, fixture.account)
      fixture.resumedSessions.push({ sessionId, generation, account: fixture.account })
      return {
        _meta: {
          antigravity: {
            tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: '' },
          },
        },
      }
    })
    .onRequest(methods.agent.session.load, (ctx) => {
      const { sessionId } = ctx.params
      const generation = (fixture.sessionGeneration.get(sessionId) ?? 0) + 1
      fixture.sessionGeneration.set(sessionId, generation)
      fixture.sessionAccount.set(sessionId, fixture.account)
      fixture.resumedSessions.push({ sessionId, generation, account: fixture.account })
      return {
        _meta: {
          antigravity: {
            tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: '' },
          },
        },
      }
    })
    .onRequest(methods.agent.session.close, (ctx) => {
      const { sessionId } = ctx.params
      const generation = fixture.sessionGeneration.get(sessionId) ?? 0
      fixture.closedSessions.push({ sessionId, generation })
      fixture.sessionAccount.delete(sessionId)
      return {}
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const { sessionId } = ctx.params
      const generation = fixture.sessionGeneration.get(sessionId) ?? 0
      const boundAccount = fixture.sessionAccount.get(sessionId) ?? fixture.account
      const text = ctx.params.prompt
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')

      if (fixture.authRequiredAccount !== null && boundAccount === fixture.authRequiredAccount) {
        throw new RequestError(-32000, `Authentication required for ${boundAccount}`)
      }

      if (fixture.quotaExceededAccount !== null && boundAccount === fixture.quotaExceededAccount) {
        throw new RequestError(-32603, `HTTP 429: Individual quota reached for ${boundAccount}`)
      }

      if (fixture.askPermissionOnNextPrompt) {
        fixture.askPermissionOnNextPrompt = false
        await ctx.client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: `tool-${Date.now()}`,
            title: 'Run shell command',
            kind: 'execute',
            status: 'pending',
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        })
      }

      if (fixture.holdPrompts) {
        const outcome = await new Promise<{ stopReason: 'end_turn' | 'cancelled' } | Error>(
          (resolve) => {
            const pending: PendingPrompt = {
              sessionId,
              generation,
              text,
              client: ctx.client,
              resolve,
            }
            activePrompts.set(sessionId, pending)
            fixture.prompts.push(pending)
          },
        )
        activePrompts.delete(sessionId)
        if (outcome instanceof Error) throw outcome
        return { stopReason: outcome.stopReason, usage: USAGE }
      }

      notify(sessionId, ctx.client, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `[${boundAccount}] ${text}` },
      })
      return { stopReason: 'end_turn' as const, usage: USAGE }
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      const { sessionId } = ctx.params
      fixture.cancelledSessions.push(sessionId)
      activePrompts.get(sessionId)?.resolve({ stopReason: 'cancelled' })
    })

  return app
}

async function startMultiProfileHost(options?: { authStatus?: boolean }) {
  const workDir = await tempFolder('kettu-agy-work-')
  const primary = createProfileFixture('primary', 'account-a@example.com')
  const secondary = createProfileFixture('secondary', 'work@example.com')
  const other = createProfileFixture('other', 'other@example.com')

  const apps: Record<string, ReturnType<typeof buildAgentApp>> = {
    primary: buildAgentApp(primary, options),
    secondary: buildAgentApp(secondary, options),
    other: buildAgentApp(other, options),
  }

  const launcher: AgentLauncher = {
    launch: (def, spec) => {
      const key =
        def.id === 'antigravity'
          ? spec.args.some((arg) => arg.includes(workDir))
            ? 'secondary'
            : 'primary'
          : 'other'
      const transport = inProcessTransport(apps[key]!)
      let resolveExit!: (info: ExitInfo) => void
      const exited = new Promise<ExitInfo>((resolve) => (resolveExit = resolve))
      let done = false
      const finish = (info: ExitInfo) => {
        if (done) return
        done = true
        transport.close()
        resolveExit(info)
      }
      return {
        pid: null,
        startedAt: Date.now(),
        transport,
        exited,
        get hasExited() {
          return done
        },
        stop: async () => {
          finish({ code: 0, signal: null })
          return exited
        },
        kill: async () => finish({ code: null, signal: 'SIGKILL' }),
      }
    },
  }

  const settings: HostSettings = {
    locale: 'en',
    initialSetupDone: true,
    agents: {
      antigravity: { enabled: true },
      'fake-agent': { enabled: true },
    },
    addedAgents: [
      {
        id: SECOND_PROFILE,
        name: 'Work Antigravity',
        configDir: path.join(workDir, 'profile'),
        created: true,
      },
    ],
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

  const host = await startTestHost({
    fakeAs: ['antigravity'],
    launcher,
    settings,
    sessionTimings: {
      flushMs: 5,
      // Long idle timeouts so only account-change logic triggers release during tests.
      releaseHiddenMs: 600_000,
      releaseShownMs: 600_000,
      releaseUnusedMs: 600_000,
    },
  })
  hosts.push(host)
  return { host, primary, secondary, other }
}

describe('releasing live sessions on account switch (#2832)', () => {
  it('releases idle open and prepared sessions on authenticate, leaves other profiles/agents alone, and resumes on the new account', async () => {
    const { host, primary, secondary, other } = await startMultiProfileHost()
    const window = host.connect()

    const primarySession = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    const workSession = await window.request('sessions.create', {
      agentId: SECOND_PROFILE,
      projectPath: host.project,
    })
    const otherSession = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    // Keep the primary session visibly open in front, as in the user's reproduction.
    await window.open(primarySession.id)
    const prepared = await window.request('sessions.prepare', {
      agentId: 'antigravity',
      projectPath: host.project,
    })

    // First turn uses account-a; then account-a hits its quota.
    await window.request('sessions.prompt', {
      sessionId: primarySession.id,
      content: [{ type: 'text', text: 'before switch' }],
    })
    await window.until(
      () =>
        window.thread(primarySession.id).session.status === 'ready' &&
        window
          .entries(primarySession.id)
          .some((e) => e.kind === 'agent' && e.markdown.includes('[account-a@example.com]')),
    )

    primary.quotaExceededAccount = 'account-a@example.com'

    // Switch primary Antigravity to account-b via authenticate.
    primary.account = 'account-b@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-b@example.com', active: true }],
    }
    await window.request('agents.authenticate', {
      agentId: 'antigravity',
      methodId: 'oauth-personal',
    })

    // Primary's open session and prepared session were both closed; secondary profile and other agent stayed open.
    await window.until(() => window.thread(primarySession.id).session.status === 'closed')
    expect(primary.closedSessions.map((c) => c.sessionId)).toContain(primarySession.acpSessionId)
    expect(primary.closedSessions.map((c) => c.sessionId)).toContain(prepared.acpSessionId)
    expect(secondary.closedSessions).toEqual([])
    expect(other.closedSessions).toEqual([])

    const listed = await window.request('sessions.list', {})
    expect(listed.find((s) => s.id === workSession.id)?.status).toBe('ready')
    expect(listed.find((s) => s.id === otherSession.id)?.status).toBe('ready')

    // Sending the next prompt in the same open session resumes with a fresh process on account-b
    // instead of hitting account-a's 429, while preserving prior history.
    await window.request('sessions.prompt', {
      sessionId: primarySession.id,
      content: [{ type: 'text', text: 'after switch' }],
    })
    await window.until(
      () =>
        window.thread(primarySession.id).session.status === 'ready' &&
        window
          .entries(primarySession.id)
          .some(
            (e) =>
              e.kind === 'agent' && e.markdown.includes('[account-b@example.com] after switch'),
          ),
    )

    expect(primary.resumedSessions).toEqual([
      { sessionId: primarySession.acpSessionId, generation: 2, account: 'account-b@example.com' },
    ])
    const agentTexts = window
      .entries(primarySession.id)
      .filter((e) => e.kind === 'agent')
      .map((e) => e.markdown)
    expect(agentTexts).toHaveLength(2)
    expect(agentTexts[0]).toContain('[account-a@example.com]')
    expect(agentTexts[0]).toContain('before switch')
    expect(agentTexts[1]).toContain('[account-b@example.com] after switch')
  })

  it('releases idle sessions on logout without disturbing other profiles', async () => {
    const { host, primary, secondary } = await startMultiProfileHost()
    const window = host.connect()

    const primarySession = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    const workSession = await window.request('sessions.create', {
      agentId: SECOND_PROFILE,
      projectPath: host.project,
    })
    await window.open(primarySession.id)

    await window.request('agents.logout', { agentId: 'antigravity' })

    expect(primary.logoutCalls).toHaveLength(1)
    await window.until(() => window.thread(primarySession.id).session.status === 'closed')
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([primarySession.acpSessionId])
    expect(secondary.closedSessions).toEqual([])
    const listed = await window.request('sessions.list', {})
    expect(listed.find((s) => s.id === workSession.id)?.status).toBe('ready')
  })

  it('refreshAccount releases only when account identity changes and is a no-op when unchanged', async () => {
    const { host, primary } = await startMultiProfileHost()
    const window = host.connect()

    const session = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    await window.open(session.id)
    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'seed history' }],
    })
    await window.until(() => window.thread(session.id).session.status === 'ready')

    // Identical refreshes (regular and forced) must NOT release the live session.
    await window.request('agents.refreshAccount', { agentId: 'antigravity' })
    await window.request('agents.refreshAccount', { agentId: 'antigravity', force: true })
    expect(primary.closedSessions).toEqual([])
    expect(window.thread(session.id).session.status).toBe('ready')

    // External account switch to a different email triggers release.
    primary.account = 'account-b@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-b@example.com', active: true }],
    }
    await window.request('agents.refreshAccount', { agentId: 'antigravity', force: true })

    await window.until(() => window.thread(session.id).session.status === 'closed')
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([session.acpSessionId])

    // Reopen on account-b, then observe signed-in -> signed-out via refreshAccount.
    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'reattach' }],
    })
    await window.until(
      () =>
        window.thread(session.id).session.status === 'ready' &&
        window
          .entries(session.id)
          .some(
            (e) => e.kind === 'agent' && e.markdown.includes('[account-b@example.com] reattach'),
          ),
    )
    expect(primary.resumedSessions).toHaveLength(1)

    primary.authStatus = { state: 'unauthenticated', accounts: [] }
    await window.request('agents.refreshAccount', { agentId: 'antigravity', force: true })
    await window.until(() => window.thread(session.id).session.status === 'closed')
    expect(primary.closedSessions).toHaveLength(2)

    // Re-attach while still unauthenticated, then observe signed-out -> signed-in via refreshAccount.
    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'before relogin' }],
    })
    await window.until(() => window.thread(session.id).session.status === 'ready')
    primary.account = 'account-c@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-c@example.com', active: true }],
    }
    await window.request('agents.refreshAccount', { agentId: 'antigravity', force: true })
    await window.until(() => window.thread(session.id).session.status === 'closed')
    expect(primary.closedSessions).toHaveLength(3)
  })

  it('releases idle sessions after terminal sign-in completes even when no email is reported', async () => {
    const { host, primary } = await startMultiProfileHost({ authStatus: false })
    const window = host.connect()

    const session = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    await window.open(session.id)

    // Without afterSignIn, refreshing an unchanged same-tier Antigravity account is a no-op.
    await window.request('agents.refreshAccount', { agentId: 'antigravity', force: true })
    expect(primary.closedSessions).toEqual([])
    expect(window.thread(session.id).session.status).toBe('ready')

    // After terminal sign-in finishes (bootstrap sends afterSignIn: true), release idle sessions.
    primary.account = 'account-b@example.com'
    await window.request('agents.refreshAccount', {
      agentId: 'antigravity',
      force: true,
      afterSignIn: true,
    })
    await window.until(() => window.thread(session.id).session.status === 'closed')
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([session.acpSessionId])
  })

  it('defers release of a busy turn (including agy waitingBackground) until truly idle, then resumes fresh', async () => {
    const { host, primary } = await startMultiProfileHost()
    const window = host.connect()
    primary.holdPrompts = true

    const session = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    await window.open(session.id)

    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'long running task' }],
    })
    await window.until(() => primary.prompts.length === 1)
    const active = primary.prompts[0]!

    // Emit a reply chunk + tool-less usage_update so agy enters waitingBackground while holding prompt open.
    await active.client.notify(methods.client.session.update, {
      sessionId: active.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Waiting for background worker...' },
      } as SessionUpdate,
    })
    await active.client.notify(methods.client.session.update, {
      sessionId: active.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 1200,
        size: 100_000,
      } as SessionUpdate,
    })
    await window.until(() => window.thread(session.id).session.waitingBackground === true)

    // Switch account while the session is in waitingBackground.
    primary.quotaExceededAccount = 'account-a@example.com'
    primary.account = 'account-b@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-b@example.com', active: true }],
    }
    await window.request('agents.authenticate', {
      agentId: 'antigravity',
      methodId: 'oauth-personal',
    })

    // Must NOT abort or close while waiting on background work.
    expect(primary.cancelledSessions).toEqual([])
    expect(primary.closedSessions).toEqual([])
    expect(window.thread(session.id).session.status).toBe('running')

    // Once the background work finishes and the turn ends, the stale session releases automatically.
    active.resolve({ stopReason: 'end_turn' })
    await window.until(() => window.thread(session.id).session.status === 'closed')
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([session.acpSessionId])

    // The next prompt resumes with a fresh connection on account-b.
    primary.holdPrompts = false
    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'follow-up on new account' }],
    })
    await window.until(
      () =>
        window.thread(session.id).session.status === 'ready' &&
        window
          .entries(session.id)
          .some(
            (e) =>
              e.kind === 'agent' &&
              e.markdown.includes('[account-b@example.com] follow-up on new account'),
          ),
    )
    expect(primary.resumedSessions).toHaveLength(1)
  })

  it('reattaches on the new account before sending a queued follow-up after a busy turn finishes', async () => {
    const { host, primary } = await startMultiProfileHost()
    const window = host.connect()
    primary.holdPrompts = true

    const session = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    await window.open(session.id)

    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'first turn' }],
    })
    await window.until(() => primary.prompts.length === 1)
    const first = primary.prompts[0]!

    // Queue a second prompt while the first turn is still running.
    await window.request('sessions.queue', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'queued follow-up' }],
    })

    // Switch accounts while the first turn is running and mark the old account quota-exhausted.
    primary.quotaExceededAccount = 'account-a@example.com'
    primary.account = 'account-b@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-b@example.com', active: true }],
    }
    await window.request('agents.authenticate', {
      agentId: 'antigravity',
      methodId: 'oauth-personal',
    })
    expect(primary.closedSessions).toEqual([])

    // Finish the first turn; the queued follow-up must detach the stale session and resume on account-b.
    primary.holdPrompts = false
    first.resolve({ stopReason: 'end_turn' })
    await window.until(
      () =>
        window.thread(session.id).session.status === 'ready' &&
        window
          .entries(session.id)
          .some(
            (e) =>
              e.kind === 'agent' && e.markdown.includes('[account-b@example.com] queued follow-up'),
          ),
    )
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([session.acpSessionId])
    expect(primary.resumedSessions).toEqual([
      { sessionId: session.acpSessionId, generation: 2, account: 'account-b@example.com' },
    ])
  })

  it('does not release while awaiting a permission card, and releases once answered and idle', async () => {
    const { host, primary } = await startMultiProfileHost()
    const window = host.connect()
    primary.askPermissionOnNextPrompt = true

    const session = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    await window.open(session.id)

    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'needs permission' }],
    })
    await window.until(() => window.thread(session.id).session.status === 'awaiting_permission')

    // Switch account while the permission card is open.
    primary.account = 'account-b@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-b@example.com', active: true }],
    }
    await window.request('agents.authenticate', {
      agentId: 'antigravity',
      methodId: 'oauth-personal',
    })

    expect(primary.closedSessions).toEqual([])
    expect(window.thread(session.id).session.status).toBe('awaiting_permission')

    // Answer the permission card; once the turn completes, the stale connection releases.
    const tool = window.entries(session.id).find((e) => e.kind === 'tool' && e.permission)
    expect(tool && tool.kind === 'tool' && tool.permission).toBeTruthy()
    const requestId = tool!.kind === 'tool' ? tool!.permission!.requestId : ''
    await window.request('permissions.respond', {
      sessionId: session.id,
      requestId,
      optionId: 'allow',
    })

    await window.until(() => window.thread(session.id).session.status === 'closed')
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([session.acpSessionId])
  })

  it('detaches a stale connection on an auth_required session so automatic retry resumes fresh', async () => {
    const { host, primary } = await startMultiProfileHost()
    const window = host.connect()

    const session = await window.request('sessions.create', {
      agentId: 'antigravity',
      projectPath: host.project,
    })
    await window.open(session.id)

    // The existing connection's account expires and rejects the next prompt with auth_required.
    primary.authRequiredAccount = 'account-a@example.com'
    await window.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'retry me on new account' }],
    })
    await window.until(() => window.thread(session.id).session.status === 'auth_required')

    // Re-authenticating with account-b detaches the stale connection and retries on a resumed one.
    primary.account = 'account-b@example.com'
    primary.authStatus = {
      state: 'authenticated',
      accounts: [{ label: 'Google AI Pro', email: 'account-b@example.com', active: true }],
    }
    await window.request('agents.authenticate', {
      agentId: 'antigravity',
      methodId: 'oauth-personal',
    })

    await window.until(
      () =>
        window.thread(session.id).session.status === 'ready' &&
        window
          .entries(session.id)
          .some(
            (e) =>
              e.kind === 'agent' &&
              e.markdown.includes('[account-b@example.com] retry me on new account'),
          ),
    )
    expect(primary.closedSessions.map((c) => c.sessionId)).toEqual([session.acpSessionId])
    expect(primary.resumedSessions).toEqual([
      { sessionId: session.acpSessionId, generation: 2, account: 'account-b@example.com' },
    ])
  })
})
