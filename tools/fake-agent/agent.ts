// A scripted ACP agent for development and tests. It never calls a model.

import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type AgentContext,
  type AuthMethod,
  type AvailableCommand,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
  type Usage,
} from '@agentclientprotocol/sdk/unstable'
import {
  SCENARIOS,
  SCENARIO_DESCRIPTIONS,
  chooseScenario,
  delayScale,
  historyEntries,
  type Env,
  type ScenarioName,
} from './options.ts'
import { SCENARIO_RUNNERS, compact, syntheticHistory } from './scenarios.ts'
import type { FakeSessionState, Turn } from './turn.ts'

export const FAKE_AGENT_VERSION = '0.1.0'

export interface FakeAgentOptions {
  env?: Env
  /** Ends the process; in-process tests pass a function that closes the connection. */
  exit?: (code: number) => void
  /** A line for stderr, where real adapters print their progress. */
  log?: (line: string) => void
}

/** The file `main.ts --login` creates, which signs a signed-out agent back in. */
export function loginMarkerPath(env: Env): string {
  return env.FAKE_AGENT_LOGIN_MARKER ?? join(tmpdir(), 'overbench-fake-agent-login')
}

interface Recorded {
  sessionId: string
  update: SessionUpdate
}

interface ForkPoint {
  version?: unknown
  messageId: string
  messageFingerprint?: string
  messageOccurrence?: number
}

interface FakeSession extends FakeSessionState {
  history: Recorded[]
  turnStarts: number[] // where each prompt's records begin in `history`
  updatedAt: string
  turn: { abort: AbortController; ignoreCancel: boolean } | null
}

const HISTORY_LIMIT = 50_000

const MODES = [
  { id: 'ask', name: 'Ask', description: 'Asks before every edit' },
  { id: 'code', name: 'Code', description: 'Edits files without asking' },
  { id: 'plan', name: 'Plan', description: 'Plans without touching files' },
]

const DEFAULT_CONFIG: Pick<FakeSessionState, 'mode' | 'model' | 'thought' | 'fast'> = {
  mode: 'ask',
  model: 'balanced',
  thought: 'medium',
  fast: false,
}

const SCENARIO_TITLES: Partial<Record<ScenarioName | 'compact', string>> = {
  'basic-turn': 'Fix the flaky login test',
  'long-stream': 'A very long answer',
  'tool-storm': 'Scan the whole repository',
  permission: 'Run the login tests',
  'parallel-permissions': 'Three approvals at once',
  subagent: 'Explore with a subagent',
  plan: 'Follow a plan',
  thinking: 'Think it through',
}

export function createFakeAgent(options: FakeAgentOptions = {}): AgentApp {
  const env = options.env ?? process.env
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const scale = delayScale(env)
  const legacyModes = env.FAKE_AGENT_LEGACY_MODES === '1'
  const forkConfig = env.FAKE_AGENT_FORK_CONFIG ?? 'keep'
  const resumeConfig = env.FAKE_AGENT_RESUME_CONFIG ?? 'keep'
  // Not scaled: it stands for an agent that is slow to take a setting, whatever the pace.
  const setConfigMs = Number(env.FAKE_AGENT_SET_CONFIG_MS ?? '') || 0
  const settled = (): Promise<void> | undefined =>
    setConfigMs > 0 ? new Promise((resolve) => setTimeout(resolve, setConfigMs)) : undefined
  const sessions = new Map<string, FakeSession>()
  const lockedSessions = new Set<string>()
  const levelHidden = new Set<string>()
  const children = new Map<string, () => void>()
  let connection: AgentConnection | null = null
  let clientCapabilities: ClientCapabilities = {}
  let signedIn = env.FAKE_AGENT_AUTH !== 'required'
  let counter = 0

  const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++counter}`

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const scaled = ms * scale
      // A timer waits for the next system tick, about 15 ms on Windows, so a stream behind its
      // schedule would never catch up; with no wait left it only yields.
      if (scaled <= 0) {
        setImmediate(resolve)
        return
      }
      const done = (): void => {
        signal?.removeEventListener('abort', done)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, scaled)
      signal?.addEventListener('abort', done, { once: true })
    })

  const authStatus = (): Record<string, unknown> =>
    signedIn
      ? {
          kind: 'account',
          label: 'Fake Pro',
          account: { plan: 'pro', email: 'developer@example.com' },
        }
      : { kind: 'none', label: 'Not logged in' }

  const pushAuthStatus = (): void => {
    void connection?.client
      .notify('_auth/status_update', { authStatus: authStatus() })
      .catch(() => {})
  }

  const requireSignedIn = (): void => {
    const marker = loginMarkerPath(env)
    if (!signedIn && existsSync(marker)) {
      rmSync(marker, { force: true })
      signedIn = true
      pushAuthStatus()
    }
    if (!signedIn) throw RequestError.authRequired(undefined, 'Sign in to the fake agent')
  }

  const configOptions = (session: FakeSession): SessionConfigOption[] => {
    const list: SessionConfigOption[] = []
    if (!legacyModes) {
      list.push({
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: session.mode,
        options: MODES.map((mode) => ({
          value: mode.id,
          name: mode.name,
          description: mode.description,
        })),
      })
    }
    list.push(
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: session.model,
        options: [
          {
            group: 'fast',
            name: 'Fast',
            options: [{ value: 'swift', name: 'Fake Swift', description: 'Quick answers' }],
          },
          {
            group: 'smart',
            name: 'Smart',
            options: [
              { value: 'balanced', name: 'Fake Balanced', description: 'The default' },
              { value: 'deep', name: 'Fake Deep', description: 'Slow and thorough' },
            ],
          },
        ],
      },
      {
        id: 'thought_level',
        name: 'Reasoning',
        category: 'thought_level',
        type: 'select',
        currentValue: session.thought,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'fast',
        name: 'Fast mode',
        description: 'Trades depth for speed',
        category: 'model_config',
        type: 'boolean',
        currentValue: session.fast,
      },
    )
    return levelHidden.has(session.id) ? list.filter((o) => o.id !== 'thought_level') : list
  }

  const modeState = (session: FakeSession): SessionModeState | undefined =>
    legacyModes ? { currentModeId: session.mode, availableModes: MODES } : undefined

  const sessionSetup = (
    session: FakeSession,
  ): { configOptions: SessionConfigOption[]; modes?: SessionModeState } => {
    const modes = modeState(session)
    return { configOptions: configOptions(session), ...(modes ? { modes } : {}) }
  }

  /** `history-<n>`, a session to import whose replay has n entries, as the perf script uses. */
  const historySize = (id: string): number | null => {
    const match = /^history-(\d+)$/.exec(id)
    return match ? Number(match[1]) : null
  }

  const newSession = (id: string, cwd: string): FakeSession => {
    const session: FakeSession = {
      id,
      cwd,
      title: null,
      turns: 0,
      usedTokens: 0,
      largeHistory: id.startsWith('large-history') ? historyEntries(env) : historySize(id),
      signedOut: false,
      ...DEFAULT_CONFIG,
      history: [],
      turnStarts: [],
      updatedAt: new Date().toISOString(),
      turn: null,
    }
    sessions.set(id, session)
    return session
  }

  /** Like codex-acp, which opens every session it resumes or loads at its defaults. */
  const reopened = (session: FakeSession): void => {
    if (resumeConfig === 'keep') return
    Object.assign(session, DEFAULT_CONFIG)
    if (resumeConfig === 'locked') lockedSessions.add(session.id)
  }

  const commands = (): AvailableCommand[] => [
    ...SCENARIOS.map((name) => ({
      name,
      description: SCENARIO_DESCRIPTIONS[name].description,
      ...(SCENARIO_DESCRIPTIONS[name].hint
        ? { input: { hint: SCENARIO_DESCRIPTIONS[name].hint! } }
        : {}),
    })),
    {
      name: 'scenario',
      description: 'Run a scenario by name',
      input: { hint: '<name> [--flags]' },
    },
    { name: 'compact', description: 'Summarize the conversation to free context' },
  ]

  const announceCommands = (client: AgentContext, sessionId: string): void => {
    void client
      .notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: commands() },
      })
      .catch(() => {})
  }

  const record = (session: FakeSession, sessionId: string, update: SessionUpdate): void => {
    if (session.history.length < HISTORY_LIMIT) session.history.push({ sessionId, update })
  }

  const promptText = (prompt: ContentBlock[]): string =>
    prompt
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()

  /** The text of the prompt whose records begin at `start`. */
  const promptAt = (session: FakeSession, start: number): string => {
    const blocks: ContentBlock[] = []
    for (const { sessionId, update } of session.history.slice(start)) {
      if (sessionId !== session.id || update.sessionUpdate !== 'user_message_chunk') break
      blocks.push(update.content)
    }
    return promptText(blocks)
  }

  /**
   * Where a fork's history ends: after the turn of the message a fork point names, in
   * `_meta.jetbrains.air.fork` as both official adapters read it, else at the end. Like them, it
   * looks the id up first, and only for an unknown id takes the nth message with the fingerprint.
   */
  const forkEnd = (
    source: FakeSession,
    meta: Record<string, unknown> | null | undefined,
  ): number => {
    const point = (meta?.jetbrains as { air?: { fork?: ForkPoint } } | undefined)?.air?.fork
    if (point?.version !== 1) return source.history.length
    const messages = new Map<string, { text: string; at: number }>()
    source.history.forEach(({ sessionId, update }, i) => {
      if (sessionId !== source.id || update.sessionUpdate !== 'agent_message_chunk') return
      if (!update.messageId) return
      const text = update.content.type === 'text' ? update.content.text : ''
      const known = messages.get(update.messageId)
      messages.set(update.messageId, { text: (known?.text ?? '') + text, at: i })
    })
    const fingerprint = (text: string): string =>
      `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
    const found =
      messages.get(point.messageId) ??
      [...messages.values()].filter((m) => fingerprint(m.text) === point.messageFingerprint)[
        (point.messageOccurrence ?? 1) - 1
      ]
    if (!found) {
      throw RequestError.invalidParams(
        { messageId: point.messageId },
        `Fork point message ${point.messageId} was not found in session ${source.id}`,
      )
    }
    return source.turnStarts.find((start) => start > found.at) ?? source.history.length
  }

  // The turn's own counts, as every adapter reports them; cache reads grow with the context.
  const tokenUsage = (session: FakeSession): Usage => {
    const input = 900
    const output = 420
    const cacheRead = 1200 * session.turns
    const cacheWrite = 200
    return {
      totalTokens: input + output + cacheRead + cacheWrite,
      inputTokens: input,
      outputTokens: output,
      thoughtTokens: 80,
      cachedReadTokens: cacheRead,
      cachedWriteTokens: cacheWrite,
    }
  }

  // `_meta.quota.model_usage`, as Claude Code and Codex send it: the turn's counts per model.
  const modelUsage = (session: FakeSession) => {
    const usage = tokenUsage(session)
    return {
      quota: {
        model_usage: [
          {
            model: session.model,
            token_count: {
              totalTokens: usage.totalTokens,
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedReadTokens,
              cachedWriteTokens: usage.cachedWriteTokens,
              outputTokens: usage.outputTokens,
              reasoningOutputTokens: usage.thoughtTokens,
            },
          },
        ],
      },
    }
  }

  const replay = async (client: AgentContext, session: FakeSession): Promise<void> => {
    if (session.largeHistory !== null) {
      for (const update of syntheticHistory(session.largeHistory)) {
        await client.notify(methods.client.session.update, { sessionId: session.id, update })
      }
      return
    }
    for (const item of session.history) {
      await client.notify(methods.client.session.update, item)
    }
  }

  // FAKE_AGENT_WITHOUT leaves session capabilities out, such as `close`, or image input (`image`).
  const without = new Set((env.FAKE_AGENT_WITHOUT ?? '').split(',').map((name) => name.trim()))
  const sessionCapabilities = () =>
    Object.fromEntries(
      ['list', 'resume', 'close', 'delete', 'fork']
        .filter((name) => !without.has(name))
        .map((name) => [name, {}]),
    )

  return agent({ name: 'fake-agent' })
    .onConnect((opened) => {
      connection = opened
    })
    .onRequest(methods.agent.initialize, async (ctx) => {
      clientCapabilities = ctx.params.clientCapabilities ?? {}
      const slowMs =
        Number(env.FAKE_AGENT_SLOW_START_MS ?? '') ||
        (env.FAKE_AGENT_SCENARIO === 'slow-start' ? 20_000 : 0)
      if (slowMs > 0) {
        const steps = 10
        for (let step = 1; step <= steps; step++) {
          log(`fake-agent: downloading the adapter… ${step * 10}%`)
          await sleep(slowMs / steps)
        }
      }
      const authMethods: AuthMethod[] = [
        { id: 'fake-login', name: 'Fake sign-in', description: 'Signs in without a browser' },
      ]
      if (clientCapabilities.auth?.terminal) {
        authMethods.push({
          id: 'fake-terminal-login',
          name: 'Sign in in a terminal',
          description: 'Runs the fake agent with --login',
          type: 'terminal',
          args: ['--login'],
        })
      }
      const response: InitializeResponse = {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: !without.has('image'), embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: sessionCapabilities(),
          auth: { logout: {} },
          _meta: { authStatus: {} },
        },
        authMethods,
        agentInfo: {
          name: env.FAKE_AGENT_NAME ?? 'fake-agent',
          title: 'Fake agent',
          version: FAKE_AGENT_VERSION,
        },
        // Like claude-agent-acp: `_session/steering`, advertised beside the capabilities.
        _meta: { steering: { supported: true } },
      }
      // Like claude-agent-acp, the first account push follows the initialize response.
      setTimeout(pushAuthStatus, 0)
      return response
    })
    .onRequest(methods.agent.authenticate, (ctx) => {
      if (ctx.params.methodId !== 'fake-login') {
        throw RequestError.invalidParams(undefined, `Unknown auth method ${ctx.params.methodId}`)
      }
      signedIn = true
      pushAuthStatus()
      return {}
    })
    .onRequest(methods.agent.logout, () => {
      signedIn = false
      pushAuthStatus()
      return {}
    })
    .onRequest(methods.agent.session.new, async (ctx) => {
      requireSignedIn()
      // Not scaled: it stands for an agent that is slow to open a session, whatever the pace.
      const slowMs = Number(env.FAKE_AGENT_NEW_SESSION_MS ?? '') || 0
      if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs))
      const session = newSession(nextId('fake'), ctx.params.cwd)
      setTimeout(() => announceCommands(ctx.client, session.id), 0)
      return { sessionId: session.id, ...sessionSetup(session) }
    })
    .onRequest(methods.agent.session.load, async (ctx) => {
      requireSignedIn()
      let session = sessions.get(ctx.params.sessionId)
      if (!session) {
        session = newSession(ctx.params.sessionId, ctx.params.cwd)
        session.title = 'Restored session'
        if (session.largeHistory === null) {
          for (const update of syntheticHistory(8)) record(session, session.id, update)
        }
      }
      await replay(ctx.client, session)
      announceCommands(ctx.client, session.id)
      reopened(session)
      return sessionSetup(session)
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      requireSignedIn()
      let session = sessions.get(ctx.params.sessionId)
      if (!session) {
        // Like Claude Code, which keeps no history for a session nothing was sent to.
        if (env.FAKE_AGENT_RESUME_UNKNOWN === 'fail') {
          throw RequestError.resourceNotFound(ctx.params.sessionId)
        }
        // A real agent resumes a session it already titled, so the next prompt keeps the title.
        session = newSession(ctx.params.sessionId, ctx.params.cwd)
        session.title = 'Restored session'
      }
      reopened(session)
      setTimeout(() => announceCommands(ctx.client, session.id), 0)
      return sessionSetup(session)
    })
    .onRequest(
      '_session/steering',
      (params: unknown) =>
        params as {
          sessionId: string
          prompt: ContentBlock[]
          _meta?: { steering?: { idleBehavior?: string } }
        },
      async (ctx) => {
        const session = sessions.get(ctx.params.sessionId)
        if (!session) throw RequestError.resourceNotFound(ctx.params.sessionId)
        if (!session.turn) {
          if (ctx.params._meta?.steering?.idleBehavior === 'promptRequired') {
            return { outcome: 'promptRequired', reason: 'noRunningTurn' }
          }
          throw RequestError.invalidRequest(undefined, 'No turn is running')
        }
        for (const block of ctx.params.prompt) {
          record(session, session.id, { sessionUpdate: 'user_message_chunk', content: block })
        }
        const update: SessionUpdate = {
          sessionUpdate: 'agent_message_chunk',
          messageId: nextId('msg'),
          content: { type: 'text', text: `Noted mid-turn: ${promptText(ctx.params.prompt)}` },
        }
        record(session, session.id, update)
        // Like Claude Code, the answer to a steered message streams after the request returns.
        setTimeout(() => {
          void ctx.client
            .notify(methods.client.session.update, { sessionId: session.id, update })
            .catch(() => {})
        }, 0)
        return { outcome: 'injected' }
      },
    )
    .onRequest(methods.agent.session.fork, (ctx) => {
      requireSignedIn()
      const source = sessions.get(ctx.params.sessionId)
      if (!source) throw RequestError.resourceNotFound(ctx.params.sessionId)
      const end = forkEnd(source, ctx.params._meta)
      const fork = newSession(nextId('fake'), ctx.params.cwd)
      fork.title = source.title
      fork.turnStarts = source.turnStarts.filter((start) => start < end)
      fork.turns = end < source.history.length ? fork.turnStarts.length : source.turns
      fork.usedTokens = source.usedTokens
      if (forkConfig === 'keep') {
        fork.mode = source.mode
        fork.model = source.model
        fork.thought = source.thought
        fork.fast = source.fast
      } else if (forkConfig === 'reset') {
        // Like codex-acp, it lists the level only once a model is set.
        levelHidden.add(fork.id)
      } else if (forkConfig === 'locked') {
        lockedSessions.add(fork.id)
      }
      fork.history = source.history.slice(0, end).map((r) => ({ ...r, sessionId: fork.id }))
      setTimeout(() => announceCommands(ctx.client, fork.id), 0)
      return { sessionId: fork.id, ...sessionSetup(fork) }
    })
    .onRequest(methods.agent.session.list, (ctx) => {
      const cwd = ctx.params.cwd ?? null
      const day = 24 * 3600 * 1000
      const known: SessionInfo[] = [...sessions.values()].map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
      }))
      const synthetic: SessionInfo[] = [
        {
          sessionId: 'cli-refactor-router',
          cwd: cwd ?? tmpdir(),
          title: 'Started in the CLI: refactor the router',
          updatedAt: new Date(Date.now() - day).toISOString(),
        },
        {
          sessionId: 'large-history-1',
          cwd: cwd ?? tmpdir(),
          title: 'Large history (1,000 entries)',
          updatedAt: new Date(Date.now() - 2 * day).toISOString(),
        },
      ]
      const all = [...known, ...synthetic.filter((s) => !sessions.has(s.sessionId))].filter(
        (session) => cwd === null || session.cwd === cwd,
      )
      const pageSize = Number(env.FAKE_AGENT_LIST_PAGE ?? '') || 50
      const offset = Number(ctx.params.cursor ?? '0') || 0
      const page = all.slice(offset, offset + pageSize)
      const next = offset + pageSize < all.length ? String(offset + pageSize) : null
      return { sessions: page, nextCursor: next }
    })
    .onRequest(methods.agent.session.close, (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort.abort()
      return {}
    })
    .onRequest(methods.agent.session.delete, async (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort.abort()
      sessions.delete(ctx.params.sessionId)
      // Not scaled: it stands for an agent that is slow to delete a session's history.
      const slowMs = Number(env.FAKE_AGENT_DELETE_MS ?? '') || 0
      if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs))
      return {}
    })
    .onRequest(methods.agent.session.setMode, async (ctx) => {
      await settled()
      const session = sessions.get(ctx.params.sessionId)
      if (!session) throw RequestError.resourceNotFound(ctx.params.sessionId)
      if (lockedSessions.has(session.id)) throw RequestError.invalidParams(undefined, 'Locked')
      if (!MODES.some((mode) => mode.id === ctx.params.modeId)) {
        throw RequestError.invalidParams(undefined, `Unknown mode ${ctx.params.modeId}`)
      }
      session.mode = ctx.params.modeId
      setTimeout(() => {
        void ctx.client
          .notify(methods.client.session.update, {
            sessionId: session.id,
            update: { sessionUpdate: 'current_mode_update', currentModeId: session.mode },
          })
          .catch(() => {})
      }, 0)
      return {}
    })
    .onRequest(methods.agent.session.setConfigOption, async (ctx) => {
      await settled()
      const session = sessions.get(ctx.params.sessionId)
      if (!session) throw RequestError.resourceNotFound(ctx.params.sessionId)
      if (lockedSessions.has(session.id)) throw RequestError.invalidParams(undefined, 'Locked')
      const value = ctx.params.value
      switch (ctx.params.configId) {
        case 'mode':
          if (typeof value !== 'string' || !MODES.some((m) => m.id === value)) {
            throw RequestError.invalidParams(undefined, 'Unknown mode')
          }
          session.mode = value
          break
        case 'model':
          if (typeof value !== 'string' || !['swift', 'balanced', 'deep'].includes(value)) {
            throw RequestError.invalidParams(undefined, 'Unknown model')
          }
          session.model = value
          levelHidden.delete(session.id)
          break
        case 'thought_level':
          if (typeof value !== 'string' || !['low', 'medium', 'high'].includes(value)) {
            throw RequestError.invalidParams(undefined, 'Unknown reasoning level')
          }
          session.thought = value
          break
        case 'fast':
          if (typeof value !== 'boolean')
            throw RequestError.invalidParams(undefined, 'Expected a boolean')
          session.fast = value
          break
        default:
          throw RequestError.invalidParams(undefined, `Unknown option ${ctx.params.configId}`)
      }
      return { configOptions: configOptions(session) }
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      const id = ctx.params.sessionId
      const childCancel = children.get(id)
      if (childCancel) {
        childCancel()
        return
      }
      const turn = sessions.get(id)?.turn
      if (!turn) return
      if (turn.ignoreCancel) {
        log(`fake-agent: ignoring session/cancel for ${id}`)
        return
      }
      turn.abort.abort()
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      requireSignedIn()
      const session = sessions.get(ctx.params.sessionId)
      if (!session) throw RequestError.resourceNotFound(ctx.params.sessionId)
      if (session.turn) throw RequestError.invalidRequest(undefined, 'A turn is already running')
      const text = promptText(ctx.params.prompt)
      const choice = chooseScenario(text, env)
      const abort = new AbortController()
      session.turn = { abort, ignoreCancel: choice.options.ignoreCancel }
      session.turns++
      session.updatedAt = new Date().toISOString()
      const lastStart = session.turnStarts.at(-1)
      const previousPrompt = lastStart === undefined ? null : promptAt(session, lastStart)
      session.turnStarts.push(session.history.length)
      for (const block of ctx.params.prompt) {
        record(session, session.id, { sessionUpdate: 'user_message_chunk', content: block })
      }

      const send = async (update: SessionUpdate, sessionId = session.id): Promise<void> => {
        record(session, sessionId, update)
        await ctx.client.notify(methods.client.session.update, { sessionId, update })
      }
      const turn: Turn = {
        session,
        options: choice.options,
        text: choice.text,
        prompt: ctx.params.prompt,
        previousPrompt,
        signal: abort.signal,
        supportsSubagents:
          typeof clientCapabilities.subagents === 'object' && clientCapabilities.subagents !== null,
        send,
        sendRaw: (update) =>
          ctx.client.notify(methods.client.session.update, { sessionId: session.id, update }),
        sleep: (ms) => sleep(ms, abort.signal),
        requestPermission: async (toolCall, permissionOptions, request = {}) => {
          const withdraw = new AbortController()
          const timer =
            request.withdrawAfterMs != null
              ? setTimeout(() => withdraw.abort(), request.withdrawAfterMs * scale)
              : null
          try {
            const response = await ctx.client.request(
              methods.client.session.requestPermission,
              { sessionId: request.sessionId ?? session.id, toolCall, options: permissionOptions },
              { cancellationSignal: withdraw.signal },
            )
            return response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled'
          } catch (error) {
            if (withdraw.signal.aborted) return 'withdrawn'
            throw error
          } finally {
            if (timer) clearTimeout(timer)
          }
        },
        registerChild: (childId, cancelChild) => children.set(childId, cancelChild),
        signOut: () => {
          signedIn = false
          pushAuthStatus()
        },
        exit,
        log,
        messageId: () => nextId('msg'),
      }

      try {
        if (session.title === null && choice.scenario !== 'auth-required') {
          session.title =
            choice.text.split('\n')[0]!.slice(0, 50) ||
            SCENARIO_TITLES[choice.scenario] ||
            `Fake agent: ${choice.scenario}`
          await send({
            sessionUpdate: 'session_info_update',
            title: session.title,
            updatedAt: session.updatedAt,
          })
        }
        const run = choice.scenario === 'compact' ? compact : SCENARIO_RUNNERS[choice.scenario]
        const stopReason: StopReason = await run(turn)
        return {
          stopReason: abort.signal.aborted ? 'cancelled' : stopReason,
          usage: tokenUsage(session),
          _meta: modelUsage(session),
        }
      } finally {
        session.turn = null
      }
    })
}
