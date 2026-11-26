// One ACP v1 connection to an agent process, through the official SDK.
//
// The host uses the SDK's `unstable` entrypoint: its client validates every
// `session/update` against the schema of the entrypoint before any handler runs, and the
// stable schema has no `subagent_update` or `session_message`, which sub-sessions need.
// Only the unstable features the architecture allows are used (subagents, the prompt
// response's `usage`, and `session/fork` with its fork point in `_meta`); nothing else
// unstable is advertised or called.

import os from 'node:os'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AnyMessage,
  type AuthMethod,
  type AvailableCommand,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type McpServer as AcpMcpServer,
  type PromptResponse,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk/unstable'
import type { ContextBreakdown, ContextEstimates } from '@shared/context'
import type { Platform } from '@shared/platform'
import type {
  AgentId,
  ConfigOption,
  PendingConfig,
  PermissionOption,
  TokenTotals,
} from '@shared/thread'
import {
  AgentRequestError,
  optionAnswer,
  type AgentConnection,
  type AgentInit,
  type AuthMethodInfo,
  type ConnectionHooks,
  type ForkPoint,
  type ListedSession,
  type McpServer,
  type OpenedSession,
  type PermissionAnswer,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
  type SignInClient,
} from '../connection'
import { agentEntryBefore } from '../artifacts/entries'
import type { LaunchSpec, MovedAccounts } from '../catalog'
import type { AgentTransport, MessageTransport } from '../driver'
import type { Env } from '../find-command'
import { withHome } from '../shell-env'
import { t } from '../i18n'
import { planRevision } from '../plan-revision'
import {
  addEntry,
  addTokenTotals,
  isStopReason,
  mergeConfig,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import { compareVersions } from '../versions'
import {
  ANTIGRAVITY_TIER_VERSION,
  antigravityTier,
  antigravityTierMultiple,
  antigravityTierSignIn,
} from '../vendor-usage/antigravity'
import {
  GOOSE_SESSION_UPDATE,
  KNOWN_UPDATES,
  chunkTokens,
  gooseCallUsage,
  mapAuthStatus,
  mapCommands,
  mapReportedAuthStatus,
  mapConfig,
  mapModelUsage,
  mapPermissionOptions,
  mapPermissionToolCall,
  mapSessionUpdate,
  mapTokenTotals,
} from './mapper'
import { compactsAgy, sentCompact } from './agy-compact'
import {
  approved,
  buildMode,
  currentMode,
  KEEP_PLANNING,
  MODE_OPTION,
  PLAN_MODE,
  planOptions,
  plansAgy,
  planWrite,
} from './agy-plan'
import {
  AUTO_MODE,
  FULL_ACCESS,
  HELD_MODE,
  SESSION_FLAG_META,
  lacks,
  offersFullAccess,
  restoreOrder,
  withAgyModes,
} from './agy-access'
import {
  AgySessionGrants,
  AgyUserAskRules,
  SESSION_ALLOW_OPTION_ID,
  buildSessionGrantOption,
  evaluateAgyPermission,
} from './agy-auto-policy'
import { AgyBackgroundWait, agyTailReader, type AgyTailReader } from './agy-background-wait'
import { AgyCommands } from './agy-commands'
import { AgyContextEstimator, readAgyContextBreakdown, scanAgySkillsOnDisk } from './agy-context'
import { AgyMetrics, agyStepReader, type AgyStepReader } from './agy-metrics'
import { systemPromptMeta, takesSystemPromptAppend } from './agy-prompt'
import { AGY_ELICITATION, askInCard, asksQuestions, OpenAsks } from './agy-questions'
import {
  AgySubagents,
  agyStore,
  agyStoreFile,
  followsSubagents,
  PARENT_SESSION_META,
  type AgyStore,
} from './agy-subagents'
import {
  AGY_APP_DATA_DIR_FLAG,
  DEFAULT_AGY_APP_DATA_DIR,
  isSafeAgyAppDataDir,
  offersSessionArg,
  resolveAgyAppDataDir,
  SESSION_ARGS_META,
} from './agy-store'
import { PromptChain, steersAgy, type ChainAnswer } from './agy-steering'
import {
  agyAutoAllowed,
  fromAgy,
  inWholeFile,
  onAgyOwnFiles,
  throughGateway,
  type AgyAutoAllow,
} from './agy-tools'
import { fromCodeMode } from './code-mode'
import { forkPointMeta, forksAtMessage } from './fork-point'
import {
  DELETE_AGAIN_MS,
  hiddenRemoval,
  promptsHidden,
  sessionMeta,
  type Removal,
} from './hidden-sessions'
import { askedCall, mcpNaming, ownCall, type McpNaming } from './kettu-calls'
import { ownTitles } from './own-titles'
import { DELEGATED_SIGN_IN, delegatedSignInStart, requestUrlElicitation } from './sign-in'

/** A message-level stream to an agent, from a process's stdio or an in-process agent. */
export interface AcpTransport {
  readonly stream: Stream
  close(): void
}

export function processTransport(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): AcpTransport {
  const stream = ndJsonStream(
    Writable.toWeb(stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout as Readable) as ReadableStream<Uint8Array>,
  )
  return { stream, close: () => {} }
}

/** Connects an SDK `AgentApp` through an in-memory stream pair, for tests and development. */
export function inProcessTransport(app: AgentApp): AcpTransport & MessageTransport {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  const agentConnection = app.connect({ readable: toAgent.readable, writable: toClient.writable })
  return {
    kind: 'messages',
    stream: { readable: toClient.readable, writable: toAgent.writable },
    close: () => agentConnection.close(),
  }
}

/** The words for what the session router reports with a `data.reason`; the agent's own otherwise. */
function routerText(error: RequestError): string {
  const data = error.data as { reason?: unknown; folder?: unknown } | null
  if (data?.reason === 'folder_missing') {
    return t('agent.sessionFolderMissing', { folder: String(data.folder ?? '(none)') })
  }
  if (data?.reason === 'no_session_flag') return t('agent.noSessionFlag')
  return error.message
}

/** The ACP messages over what the launcher gave the driver. */
function acpTransport(transport: AcpTransport | AgentTransport): AcpTransport {
  if ('kind' in transport && transport.kind === 'stdio') {
    return processTransport(transport.stdin, transport.stdout)
  }
  return { stream: transport.stream as Stream, close: () => transport.close() }
}

/** What ACP needs to know of the agent behind it, besides the neutral hooks. */
export interface AcpOptions {
  /** The catalog's agent, whose adapter's `_meta` and hidden-session removal apply. */
  agentId?: AgentId
  /** Its name, for an error about it. */
  name?: string
  /** Accounts its vendor moved to another harness, whose refusal is no sign-in to ask for. */
  movedAccounts?: MovedAccounts
  /** Where agy's sub-agents are read from, its own conversation store unless given. */
  agyStore?: AgyStore
  /** 启动该代理的可执行命令与参数，用于执行 agy 的只读查询子命令（如 /skills）。 */
  spec?: LaunchSpec
  /** 启动该代理时的环境变量。 */
  env?: Env
  /**
   * An added agy agent's own folder, given to its process with `--gemini-dir`: agy's files are
   * read under it, and its print mode runs with it as the home folder.
   */
  home?: string
  /** 读取 agy transcript 单步用量的函数，便于单元测试注入。 */
  agyStepReader?: AgyStepReader
  /** agy 上下文定义估算器，便于单元测试注入。 */
  agyContext?: AgyContextEstimator
  /** Optional agy transcript tail reader for background-wait detection, injectable for tests. */
  agyTailReader?: AgyTailReader | null
  /** Optional settle delay (ms) for agy background-wait detection, injectable for tests. */
  agyWaitSettleMs?: number
  /** Optional fallback quiet delay (ms) for agy background-wait detection, injectable for tests. */
  agyWaitFallbackMs?: number
  /** Optional transcript-flush retry delays (ms) for agy background-wait detection, injectable for tests. */
  agyWaitRetryDelaysMs?: readonly number[]
  /** Optional resolver for which agy `app_data_dir` owns a session, injectable for tests. */
  agyAppDataDir?: (sessionId: string) => Promise<string | null>
}

export type AcpHooks = ConnectionHooks & AcpOptions

const AUTH_REQUIRED = -32000

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: true },
  session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
  subagents: {},
  // Only pages a sign-in hands over: Kettu opens them on the client that asked for the sign-in.
  elicitation: { url: {} },
  // Kilo publishes its terminal sign-in command only to a client that advertises this, and Mistral
  // Vibe its sign-in whose page the client opens.
  _meta: { 'terminal-auth': true, [DELEGATED_SIGN_IN]: true },
}

/** goose reports each model call's usage only to a client that takes its own notifications. */
const GOOSE_CLIENT_CAPABILITIES = {
  ...CLIENT_CAPABILITIES,
  _meta: { ...CLIENT_CAPABILITIES._meta, goose: { customNotifications: true } },
}

type AuthMethodMeta = {
  type?: unknown
  args?: unknown
  env?: unknown
  'env-var'?: unknown
  'terminal-auth'?: { command?: unknown; args?: unknown } | null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/** `_meta["terminal-auth"]`'s command, which runs as given rather than after the launch command. */
function namedCommand(meta: AuthMethodMeta | null | undefined): {
  command: string
  args: string[]
} | null {
  const named = meta?.['terminal-auth']
  if (typeof named !== 'object' || named === null) return null
  if (typeof named.command !== 'string' || named.command === '') return null
  return { command: named.command, args: stringList(named.args) }
}

// Agents that take HTTP MCP servers in `session/new` without declaring `mcpCapabilities`, from
// the version checked: agy 1.5.9 discovers, initializes and lists tools with the given headers.
const UNDECLARED_HTTP: Partial<Record<AgentId, string>> = {
  antigravity: '1.5.9',
}

function takesHttpUndeclared(agentId: AgentId | undefined, init: InitializeResponse): boolean {
  const since = agentId ? UNDECLARED_HTTP[agentId] : undefined
  const version = init.agentInfo?.version
  return since !== undefined && typeof version === 'string' && compareVersions(version, since) >= 0
}

/** One of `init.authMethods`, reading the metadata forms agents publish a terminal sign-in in. */
function authMethod(method: AuthMethod): AuthMethodInfo {
  const meta = method._meta as AuthMethodMeta | null | undefined
  const named = namedCommand(meta)
  const declaredType = (method as AuthMethod & { type?: unknown }).type
  const declared = declaredType === 'terminal'
  const envDeclared =
    declaredType === 'env_var' || meta?.type === 'env_var' || meta?.type === 'env-var'
  const terminal = declared || named !== null || meta?.type === 'terminal'
  const declaredArgs = (method as { args?: string[] }).args ?? []
  const args = named?.args ?? (declared ? declaredArgs : stringList(meta?.args))
  const env = declared
    ? { ...((method as { env?: Record<string, string> }).env ?? {}) }
    : stringMap(meta?.env)
  return {
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: terminal ? 'terminal' : envDeclared ? 'env' : 'agent',
    ...(named ? { command: named.command } : {}),
    args: terminal ? args : [],
    env: terminal ? env : {},
    ...(envDeclared
      ? {
          envVars: Object.entries(stringMap(meta?.env ?? (method as { env?: unknown }).env)).map(
            ([name, value]) => ({
              name,
              optional: value === 'optional',
            }),
          ),
        }
      : {}),
  }
}

// Updates for a session id nobody registered yet, such as the commands an agent sends right
// after answering `session/new`, wait here for the session to register.
const PENDING_SESSIONS = 32
const PENDING_UPDATES = 2_000
const PENDING_TTL_MS = 60_000
// OpenCode marks a subagent's updates, which it sends on the session the subagent runs under.
const CHILD_SESSION_META = 'opencode/child-session'
const CHILD_SESSIONS = 1_000
// Sessions Kettu closed: their late updates are dropped, not kept for a later register.
const CLOSED_SESSIONS = 256

/** agy's plan files in a session: the calls of this turn that write one, and what they wrote. */
interface AgyPlans {
  calls: Map<string, string>
  written: { toolCallId: string; file: string } | null
  /** The plan an earlier turn wrote, which a rewrite need not mark for review again. */
  last: string | null
}

/** agy 会话的访问模式与重启状态（同时承载完全访问重启与 Kettu 托管 Auto 模式）。 */
interface AgyAccess {
  cwd: string
  options: SessionOptions
  /** 底层进程是否以 `--dangerously-skip-permissions` 启动。 */
  full: boolean
  /** 当前是否处于 Kettu 托管的 Auto 模式（底层 agy 保持 default，审批统一经 Kettu 风险引擎）。 */
  managedAuto: boolean
  /** 底层 agy 进程当前实际的 mode 值（未覆盖前）。 */
  rawMode: string | null
  /** 展示给界面的最新配置列表（含补齐的 auto 与完全访问选项）。 */
  config: ConfigOption[]
  /** 等待当前回合或后台任务结束后切换到的目标模式。 */
  pending: string | null
  /** 正在重启 agy 进程切换到的目标模式。 */
  switching: string | null
  /** The restart under way, which the session's next requests wait for. */
  restarting: Promise<void> | null
}

/** A plan agy wrote in a turn, as the entry that shows it. */
interface AgyPlan {
  entryId: string
  toolCallId: string
  file: string
  markdown: string
  options: PermissionOption[]
}

/** Kettu's prompt blocks as ACP content blocks. */
function contentBlocks(prompt: readonly PromptBlock[]): ContentBlock[] {
  return prompt.map((block): ContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'image':
        return {
          type: 'image',
          mimeType: block.mimeType,
          data: block.data,
          ...(block.uri !== undefined ? { uri: block.uri } : {}),
        }
      case 'resource_link':
        return {
          type: 'resource_link',
          uri: block.uri,
          name: block.name,
          ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
          ...(block.size !== undefined ? { size: block.size } : {}),
        }
      case 'resource':
        return {
          type: 'resource',
          resource: {
            uri: block.resource.uri,
            mimeType: block.resource.mimeType,
            text: block.resource.text,
          },
        }
    }
  })
}

/** Kettu's MCP servers as ACP's. */
export function mcpServers(servers: readonly McpServer[] | undefined): AcpMcpServer[] {
  return (servers ?? []).map((server): AcpMcpServer => {
    if (server.type === 'stdio') {
      return {
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map(({ name, value }) => ({ name, value })),
      }
    }
    return {
      type: server.type,
      name: server.name,
      url: server.url,
      headers: server.headers.map(({ name, value }) => ({ name, value })),
    }
  })
}

export class AcpConnection implements AgentConnection {
  private readonly connection: ClientConnection
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, { at: number; updates: SessionUpdate[] }>()
  private readonly unregistered = new Set<string>()
  /** Sessions Kettu runs a report in, which no thread shows. */
  private readonly collectors = new Map<string, (update: SessionUpdate) => void>()
  /** OpenCode's subagent sessions, to the session each runs under. */
  private readonly children = new Map<string, string>()
  /** How its hidden sessions go, once `initialize` has answered. */
  private removal: Removal | null = null
  /** Hidden sessions an agent keeps once prompted: open to read, never to prompt. */
  private readonly unprompted = new Set<string>()
  /** agy 会话各权限模式下自动放行的 MCP 工具集合。 */
  private readonly autoAllowed = new Map<string, AgyAutoAllow>()
  /** The version the agent named in `initialize`. */
  private version: string | null = null
  /** How the agent names the MCP tools it calls, once `initialize` has answered. */
  private naming: McpNaming | null = null
  /** The sign-in in progress, which the next `authenticate` written out runs for. */
  private signIn: SignInClient | null = null
  /** The sign-in each `authenticate` in flight runs for, by its JSON-RPC id as a string. */
  private readonly signInRequests = new Map<string, SignInClient>()
  private readonly openAsks = new OpenAsks()
  /** Sessions with a prompt in flight. */
  private readonly prompting = new Set<string>()
  /** The tokens of the model calls of each prompt in flight, as its message chunks carried them. */
  private readonly chunkUsage = new Map<string, TokenTotals>()
  /** goose's model calls of each prompt in flight, from its own notifications, by message id. */
  private readonly gooseCalls = new Map<string, { tokens: TokenTotals | null; ids: Set<string> }>()
  /** agy's plan files, by session. */
  private readonly agyPlans = new Map<string, AgyPlans>()
  /** The mode each agy session was in before it entered Plan mode, which a plan builds in. */
  private readonly agyBuildModes = new Map<string, string>()
  /** agy offers full access, once `initialize` has answered. */
  private fullAccess = false
  /** The session router accepts per-session `--app-data-dir` routing, once `initialize` answered. */
  private agyAppDataDirRouting = false
  /** Resolved `app_data_dir` for loaded/resumed agy sessions (e.g. `'antigravity'` for IDE). */
  private readonly agyAppDataDirs = new Map<string, string>()
  /** agy takes a system prompt addition for a new session, once `initialize` has answered. */
  private appendsSystemPrompt = false
  /** agy 会话的托管模式与完全访问状态（按 sessionId 索引）。 */
  private readonly agyAccess = new Map<string, AgyAccess>()
  /** agy 根会话（及其子智能体共享）的「本会话总是允许」授权记忆。 */
  private readonly agySessionGrants = new Map<string, AgySessionGrants>()
  /** agy 用户 settings.json 中 permissions.ask 规则缓存（按文件 mtime 自动刷新）。 */
  private readonly agyUserAskRules = new AgyUserAskRules()
  /** The prompts of each agy turn running, for an agy that takes a message into one. */
  private readonly chains = new Map<string, PromptChain>()
  /** agy's commands, by session: the turn's, and those that outlived theirs. */
  private readonly agyCommands = new Map<string, AgyCommands>()
  /** agy's sub-agents, once `initialize` named a version they were measured on. */
  private subagents: AgySubagents | null = null
  /** Where each agy session was opened and with which servers, which its sub-agents load with. */
  private readonly agyOpened = new Map<string, { cwd: string; options: SessionOptions }>()
  /** Skill names discovered on disk for each agy working directory, to tag skills as stackable. */
  private readonly agySkillNames = new Map<string, ReadonlySet<string>>()
  /** Latest raw commands received per agy session, re-mapped once disk skill scan finishes. */
  private readonly agyRawCommands = new Map<string, readonly AvailableCommand[]>()
  /** The session each of agy's sub-agents was loaded under. */
  private readonly subagentParents = new Map<string, string>()
  /** Sub-agents opened again whose replay Kettu already shows. */
  private readonly muted = new Set<string>()
  /** agy 会话的单步请求计时器，结合 transcript.jsonl 输出 TPS 与最近一次请求统计。 */
  private readonly agyMetrics: AgyMetrics | null = null
  /** Detects when agy finished replying and is idle waiting on background work. */
  private agyWait: AgyBackgroundWait | null = null
  /** 仅在 Antigravity 连接上挂载：从本地轨迹库只读获取官方精确上下文分类构成。 */
  readonly readContext?: (
    sessionId: string,
    cwd: string,
    options: SessionOptions,
  ) => Promise<ContextBreakdown | null>
  /** 仅在 Antigravity 连接上挂载：估算当前会话可加载的 Skills 与 MCP 工具定义大小。 */
  readonly readContextEstimates?: (sessionId: string, cwd: string) => Promise<ContextEstimates>

  private constructor(
    private readonly transport: AcpTransport,
    private readonly hooks: AcpHooks,
  ) {
    const app = client({ name: 'Kettu' })
      .onNotification(methods.client.session.update, (ctx) => {
        this.openAsks.ended(ctx.params.sessionId, ctx.params.update)
        this.deliver(ctx.params.sessionId, ctx.params.update)
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const target = this.targets.get(ctx.params.sessionId)
        if (!target) {
          // Never approve without the user: a request for an unknown session is declined.
          hooks.log('warn', `Permission request for unknown session ${ctx.params.sessionId}`)
          return { outcome: { outcome: 'cancelled' } }
        }
        // A call through Kettu's gateway asks and shows as the tool it runs.
        const asked = this.agy ? throughGateway(ctx.params.toolCall) : ctx.params.toolCall
        const allowOnceId =
          ctx.params.options.find((option) => option.kind === 'allow_once')?.optionId ?? null
        let agyDecision: ReturnType<typeof evaluateAgyPermission> | null = null
        let agyGrants: AgySessionGrants | undefined

        if (this.agy) {
          const rootId = this.agyRootOf(ctx.params.sessionId)
          const cwd = this.agyOpened.get(rootId)?.cwd ?? null
          const autoMode = this.agyMode(ctx.params.sessionId) === AUTO_MODE
          agyGrants = this.agyGrantsOf(rootId)
          const userAskRules = autoMode
            ? await this.agyUserAskRules.read(this.hooks.home)
            : undefined
          agyDecision = evaluateAgyPermission(asked, {
            cwd,
            autoMode,
            allowed: this.autoAllowed.get(ctx.params.sessionId),
            sessionGrants: agyGrants,
            userAskRules,
            agentHome: this.hooks.home,
            agyAppDataDir: this.agyAppDataDirs.get(rootId),
          })
          if (agyDecision.action === 'allow' && allowOnceId !== null) {
            // 遵守 PLUG-7：即便命中自动放行，也必须先经过已安装插件的权限预检（插件可拒绝、不能批准）。
            if (target.hasPermissionPlugins?.() && target.checkPermissionPlugin) {
              const shaped = fromAgy(asked)
              const context = target.context()
              const toolCall = askedCall(shaped, this.naming, context)
              const { entryId, output } = mapPermissionToolCall(toolCall, context)
              const denied = await target.checkPermissionPlugin(
                {
                  toolCallId: ctx.params.toolCall.toolCallId,
                  toolEntryId: entryId,
                  output,
                  options: mapPermissionOptions(ctx.params.options),
                },
                ctx.signal,
              )
              if (denied !== null) {
                const picked = optionAnswer(denied)
                return picked === 'cancelled'
                  ? { outcome: { outcome: 'cancelled' } }
                  : { outcome: { outcome: 'selected', optionId: picked.optionId } }
              }
            }
            return { outcome: { outcome: 'selected', optionId: allowOnceId } }
          }
        }

        const shaped = this.agy
          ? await inWholeFile(
              fromAgy(asked),
              (file) => target.readProjectFile?.(file) ?? Promise.resolve(null),
            )
          : ctx.params.toolCall
        const context = target.context()
        const toolCall = askedCall(shaped, this.naming, context)
        const { entryId, output } = mapPermissionToolCall(toolCall, context)
        const options = mapPermissionOptions(ctx.params.options)
        // agy ACP 仅提供 allow_once / reject_once；对非高危拦截补齐「本会话总是允许」选项。
        if (
          this.agy &&
          agyDecision?.action === 'ask' &&
          agyDecision.sessionGrant &&
          allowOnceId !== null &&
          !options.some((option) => option.kind === 'allow_always')
        ) {
          const insertAt = options.findIndex((option) => option.kind === 'allow_once')
          const sessionOption = buildSessionGrantOption(agyDecision.sessionGrant)
          if (insertAt >= 0) options.splice(insertAt + 1, 0, sessionOption)
          else options.unshift(sessionOption)
        }
        this.agyWait?.onCardStart(ctx.params.sessionId)
        let answer: PermissionAnswer
        try {
          answer = await target.requestPermission(
            {
              toolCallId: ctx.params.toolCall.toolCallId,
              toolEntryId: entryId,
              output,
              options,
              ...(agyDecision?.action === 'ask'
                ? {
                    risk: agyDecision.risk,
                    ...(agyDecision.reason ? { reason: agyDecision.reason } : {}),
                  }
                : {}),
            },
            ctx.signal,
          )
        } finally {
          this.agyWait?.onCardEnd(ctx.params.sessionId)
        }
        const picked = optionAnswer(answer)
        if (picked === 'cancelled') return { outcome: { outcome: 'cancelled' } }
        // 用户点击 Kettu 合成的「本会话总是允许」时记住授权，并把原 allow_once ID 回传给 agy。
        if (
          this.agy &&
          picked.optionId === SESSION_ALLOW_OPTION_ID &&
          agyDecision?.action === 'ask' &&
          agyDecision.sessionGrant &&
          allowOnceId !== null
        ) {
          agyGrants?.add(agyDecision.sessionGrant)
          return { outcome: { outcome: 'selected', optionId: allowOnceId } }
        }
        return { outcome: { outcome: 'selected', optionId: picked.optionId } }
      })
      .onRequest(methods.client.elicitation.create, async (ctx) => {
        const sessionId = (ctx.params as { sessionId?: unknown }).sessionId
        // agy's questions are shown in the question card, in the session they were asked in.
        const asked = typeof sessionId === 'string' ? this.targets.get(sessionId) : undefined
        if (this.agy && asksQuestions(this.version) && asked && typeof sessionId === 'string') {
          this.agyWait?.onCardStart(sessionId)
          try {
            const answer = await this.openAsks.run(ctx.params, ctx.signal, (signal) =>
              askInCard(ctx.params, asked, signal),
            )
            if (answer) return answer
          } finally {
            this.agyWait?.onCardEnd(sessionId)
          }
        }
        // Otherwise only a sign-in's page is taken, on the client that asked for that sign-in.
        const page = requestUrlElicitation(ctx.params)
        const signIn = page ? this.signInRequests.get(page.requestId) : undefined
        if (!page || !signIn) {
          hooks.ignored(
            typeof sessionId === 'string' ? sessionId : null,
            `elicitation/create (${String(ctx.params.mode)}) outside a sign-in`,
          )
          return { action: 'decline' }
        }
        if (signIn.signal.aborted) return { action: 'cancel' }
        signIn.openLink(page.url)
        return { action: 'accept' }
      })
      // The sign-in's own `authenticate` answers once it is done.
      .onNotification(methods.client.elicitation.complete, () => {})
      .onNotification(
        'auth/status_update',
        (params: unknown) => params,
        (ctx) => {
          const status = mapReportedAuthStatus(ctx.params)
          if (!status) hooks.ignored(null, 'auth/status_update with an unknown shape')
          else {
            hooks.authState?.(status.state)
            if (status.account) hooks.account(status.account)
          }
        },
      )
      .onNotification(
        '_auth/status_update',
        (params: unknown) => params,
        (ctx) => {
          const account = mapAuthStatus(ctx.params)
          if (account) hooks.account(account)
          else hooks.ignored(null, '_auth/status_update with an unknown shape')
        },
      )
      // Only its per-call usage is read; its status, context and voice updates are not shown.
      .onNotification(
        GOOSE_SESSION_UPDATE,
        (params: unknown) => params,
        (ctx) => this.countGooseCall(ctx.params),
      )
      .onNotification('*', (ctx) => {
        // `$/cancel_request` is handled by the SDK itself before it reaches here.
        if (!ctx.method.startsWith('$/')) hooks.ignored(null, `notification ${ctx.method}`)
      })
    this.connection = app.connect(this.tap(transport.stream))
    if (this.agy) {
      this.agyMetrics = new AgyMetrics(
        hooks.agyStepReader ?? agyStepReader(hooks.home, (id) => this.agyAppDataDirOf(id)),
        {
          target: (id) => this.targets.get(id),
        },
      )
      // agy's print mode takes no `--gemini-dir`, so an added agent's runs with its folder as home.
      const platform = process.platform as Platform
      const estimator =
        hooks.agyContext ??
        new AgyContextEstimator({
          program: hooks.spec?.command,
          args: hooks.spec?.args.filter((arg) => arg !== 'acp'),
          env: hooks.home && hooks.env ? withHome(hooks.env, hooks.home, platform) : hooks.env,
          platform,
          ...(hooks.home ? { home: hooks.home } : {}),
        })
      this.readContext = async (sessionId) => {
        const appDataDir =
          this.agyAppDataDirOf(sessionId) ??
          (this.hooks.agyAppDataDir
            ? await this.hooks.agyAppDataDir(sessionId)
            : await resolveAgyAppDataDir(sessionId, hooks.home)) ??
          DEFAULT_AGY_APP_DATA_DIR
        return readAgyContextBreakdown(sessionId, hooks.home, appDataDir)
      }
      this.readContextEstimates = (sessionId, cwd) => {
        const opened = this.agyOpened.get(sessionId)
        return estimator.read(cwd, opened?.options.mcpServers ?? [])
      }
    }
  }

  static connect(transport: AcpTransport | AgentTransport, hooks: AcpHooks): AcpConnection {
    return new AcpConnection(acpTransport(transport), hooks)
  }

  /** Records traffic, and drops update variants the SDK's schema would reject noisily. */
  private tap(stream: Stream): Stream {
    const hooks = this.hooks
    const readable = stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (message, controller) => {
          hooks.traffic('in', message)
          const variant = unknownVariant(message)
          if (variant) {
            const sessionId = (message as { params: { sessionId?: unknown } }).params.sessionId
            hooks.ignored(
              typeof sessionId === 'string' ? sessionId : null,
              `session update ${variant}`,
            )
            return
          }
          controller.enqueue(message)
        },
      }),
    )
    const writer = stream.writable.getWriter()
    const writable = new WritableStream<AnyMessage>({
      write: (message) => {
        hooks.traffic('out', message)
        if (this.signIn && 'method' in message && message.method === methods.agent.authenticate) {
          if ('id' in message) this.signInRequests.set(String(message.id), this.signIn)
        }
        return writer.write(message)
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    })
    return { readable, writable }
  }

  private allowWithoutAsking(sessionId: string, options: SessionOptions): void {
    if (this.agy) this.autoAllowed.set(sessionId, agyAutoAllowed(options.mcpServers))
  }

  /** 沿子智能体父链查找 agy 会话对应的根会话 ID。 */
  private agyRootOf(sessionId: string): string {
    let root = sessionId
    const seen = new Set<string>()
    while (this.subagentParents.has(root) && !seen.has(root)) {
      seen.add(root)
      root = this.subagentParents.get(root)!
    }
    return root
  }

  /** 获取或创建 agy 根会话共享的「本会话总是允许」记忆对象。 */
  private agyGrantsOf(rootId: string): AgySessionGrants {
    let grants = this.agySessionGrants.get(rootId)
    if (!grants) {
      grants = new AgySessionGrants(process.platform as Platform)
      this.agySessionGrants.set(rootId, grants)
    }
    return grants
  }

  /** 读取 agy 会话（含子智能体继承自父会话）当前生效的权限模式值。 */
  private agyMode(sessionId: string): string | null {
    let id: string | undefined = sessionId
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const access = this.agyAccess.get(id)
      if (access?.full) return FULL_ACCESS
      if (access?.managedAuto) return AUTO_MODE
      const mode =
        currentMode(this.targets.get(id)?.context().thread.session.config ?? []) ??
        currentMode(access?.config ?? [])
      if (mode !== null) return mode
      id = this.subagentParents.get(id)
    }
    return null
  }

  /** Whether the agent is agy, whose tool calls take a shape of their own. */
  private get agy(): boolean {
    return this.hooks.agentId === 'antigravity'
  }

  private get goose(): boolean {
    return this.hooks.agentId === 'goose'
  }

  private map(sessionId: string, update: SessionUpdate, ctx: MapperContext): MapperOutput {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      if (this.agy && update.sessionUpdate === 'available_commands_update') {
        this.agyRawCommands.set(sessionId, update.availableCommands)
        const cwd = this.agyOpened.get(this.agyRootOf(sessionId))?.cwd
        return mapSessionUpdate(update, ctx, cwd ? this.agySkillNames.get(cwd) : undefined)
      }
      return mapSessionUpdate(update, ctx)
    }
    if (this.agy && onAgyOwnFiles(update, ctx)) return { patches: [], effects: [] }
    const shaped = this.agy
      ? fromAgy(throughGateway(update))
      : this.naming === 'code'
        ? fromCodeMode(update)
        : update
    const call = ownCall(shaped, this.naming, ctx)
    return call ? mapSessionUpdate(call, ctx) : { patches: [], effects: [] }
  }

  private deliver(sessionId: string, update: SessionUpdate): void {
    if (this.muted.has(sessionId)) return
    this.learnChild(sessionId, update)
    const target = this.targets.get(sessionId)
    this.countChunk(sessionId, update, target)
    if (target) {
      this.notePlanWrite(sessionId, update)
      const replaying = target.context().replaying
      this.agyWait?.onUpdate(sessionId, update, replaying)
      target.apply(this.withAccess(sessionId, this.map(sessionId, update, target.context())))
      this.noteCommand(sessionId, update, target)
      this.subagents?.noted(sessionId, update, replaying)
      this.agyMetrics?.onUpdate(sessionId, update, replaying)
      return
    }
    const collector = this.collectors.get(sessionId)
    if (collector) {
      collector(update)
      return
    }
    if (this.unregistered.has(sessionId)) {
      this.hooks.ignored(sessionId, 'update for a session Kettu closed')
      return
    }
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.at > PENDING_TTL_MS) {
        this.pending.delete(id)
        this.hooks.ignored(id, `${entry.updates.length} updates for a session Kettu does not have`)
      }
    }
    let entry = this.pending.get(sessionId)
    if (!entry) {
      if (this.pending.size >= PENDING_SESSIONS) {
        this.hooks.ignored(sessionId, 'update for an unknown session')
        return
      }
      entry = { at: now, updates: [] }
      this.pending.set(sessionId, entry)
    }
    if (entry.updates.length < PENDING_UPDATES) entry.updates.push(update)
  }

  /** Adds a model call's tokens that a chunk of a turn in flight carries, never a replayed one's. */
  private countChunk(sessionId: string, update: SessionUpdate, target?: SessionTarget): void {
    if (!this.prompting.has(sessionId) || target?.context().replaying) return
    const tokens = chunkTokens(update)
    if (!tokens) return
    this.chunkUsage.set(sessionId, addTokenTotals(this.chunkUsage.get(sessionId) ?? null, tokens))
  }

  /** Adds a model call of a goose turn in flight, each message once, never a replayed one's. */
  private countGooseCall(params: unknown): void {
    const sessionId = (params as { sessionId?: unknown } | null | undefined)?.sessionId
    if (typeof sessionId !== 'string' || !this.prompting.has(sessionId)) return
    if (this.targets.get(sessionId)?.context().replaying) return
    const call = gooseCallUsage(params)
    if (!call) return
    const turn = this.gooseCalls.get(sessionId) ?? { tokens: null, ids: new Set<string>() }
    if (call.messageId !== null) {
      if (turn.ids.has(call.messageId)) return
      turn.ids.add(call.messageId)
    }
    const tokens = mapTokenTotals(call.usage)
    if (tokens) turn.tokens = addTokenTotals(turn.tokens, tokens)
    this.gooseCalls.set(sessionId, turn)
  }

  private learnChild(sessionId: string, update: SessionUpdate): void {
    const child = (
      update._meta as Record<string, { id?: unknown } | undefined> | null | undefined
    )?.[CHILD_SESSION_META]
    const id = child?.id
    if (typeof id !== 'string' || id === sessionId || this.children.get(id) === sessionId) {
      return
    }
    this.children.delete(id)
    this.children.set(id, sessionId)
    if (this.children.size > CHILD_SESSIONS) {
      this.children.delete(this.children.keys().next().value!)
    }
  }

  /** The session `id` runs under: its own if Kettu has it, else as OpenCode reported it. */
  rootOf(id: string): string {
    return this.targets.has(id) ? id : (this.children.get(id) ?? id)
  }

  /** Routes a session's updates to `target`, first replaying any that arrived early. */
  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    for (const update of early.updates) {
      target.apply(this.withAccess(sessionId, this.map(sessionId, update, target.context())))
    }
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.pending.delete(sessionId)
    this.agyPlans.delete(sessionId)
    this.agyBuildModes.delete(sessionId)
    this.agyCommands.delete(sessionId)
    this.agyMetrics?.forget(sessionId)
    this.agyWait?.forget(sessionId)
    this.unregistered.add(sessionId)
    if (this.unregistered.size > CLOSED_SESSIONS) {
      this.unregistered.delete(this.unregistered.values().next().value!)
    }
  }

  /** Updates for a session Kettu closed wait for its next register again, like early ones. */
  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  get closed(): Promise<void> {
    return this.connection.closed
  }

  get isClosed(): boolean {
    return this.connection.signal.aborted
  }

  get systemPromptAppend(): boolean {
    return this.appendsSystemPrompt
  }

  close(): void {
    this.agyMetrics?.stop()
    this.agyWait?.stop()
    this.connection.close()
    this.transport.close()
  }

  private config(
    options: Parameters<typeof mapConfig>[0],
    modes: Parameters<typeof mapConfig>[1],
  ): ConfigOption[] {
    return mapConfig(options, modes)
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw this.toError(error)
    }
  }

  private toError(error: unknown): AgentRequestError {
    if (error instanceof AgentRequestError) return error
    if (error instanceof RequestError) {
      const moved = this.hooks.movedAccounts
      if (moved?.refusal.test(error.message)) {
        this.hooks.accountRefused?.()
        return new AgentRequestError('agent_error', t(moved.refused), error.code, {
          movedTo: moved.to,
          refusal: error.message,
        })
      }
      if (error.code === AUTH_REQUIRED) {
        return new AgentRequestError('auth_required', error.message, error.code, error.data)
      }
      return new AgentRequestError('agent_error', routerText(error), error.code, error.data)
    }
    if (this.connection.signal.aborted) {
      return new AgentRequestError('closed', 'The agent connection closed')
    }
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }

  async initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    const init: InitializeResponse = await this.call(() =>
      this.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'Kettu', title: 'Kettu', version: appVersion },
          clientCapabilities: this.agy
            ? { ...CLIENT_CAPABILITIES, elicitation: AGY_ELICITATION }
            : this.goose
              ? GOOSE_CLIENT_CAPABILITIES
              : CLIENT_CAPABILITIES,
        },
        signal ? { cancellationSignal: signal } : undefined,
      ),
    )
    if (init.protocolVersion !== 1) {
      throw new Error(
        t('agent.protocolVersion', {
          agent: this.hooks.name ?? t('agent.theAgent'),
          version: String(init.protocolVersion),
        }),
      )
    }
    const caps = init.agentCapabilities ?? {}
    const session = caps.sessionCapabilities ?? {}
    const result: AgentInit = {
      protocolVersion: init.protocolVersion,
      name: init.agentInfo?.title ?? init.agentInfo?.name ?? null,
      version: init.agentInfo?.version ?? null,
      capabilities: {
        loadSession: caps.loadSession === true,
        listSessions: session.list != null,
        resumeSession: session.resume != null,
        closeSession: session.close != null,
        deleteSession: session.delete != null,
        forkSession: session.fork != null,
        forkAtMessage: session.fork != null && forksAtMessage(init.agentInfo),
        ownTitles: ownTitles(init.agentInfo),
        logout: caps.auth?.logout != null,
        authStatus: caps.auth?.status != null,
        // `_session/steering`, an extension advertised in the response's own `_meta`; agy takes a
        // prompt into the running turn instead.
        steering:
          (init._meta as { steering?: { supported?: unknown } } | null | undefined)?.steering
            ?.supported === true ||
          (this.agy && steersAgy(init.agentInfo?.version ?? null)),
        mcpHttp:
          caps.mcpCapabilities?.http === true || takesHttpUndeclared(this.hooks.agentId, init),
        mcpSse: caps.mcpCapabilities?.sse === true,
        // Every ACP agent takes stdio servers; the others it declares.
        mcpStdio: true,
        prompt: {
          image: caps.promptCapabilities?.image === true,
          audio: caps.promptCapabilities?.audio === true,
          embeddedContext: caps.promptCapabilities?.embeddedContext === true,
        },
      },
      authMethods: (init.authMethods ?? []).map(authMethod),
      raw: init.agentCapabilities ?? null,
    }
    this.version = result.version
    this.fullAccess = this.agy && offersFullAccess(result.version, init._meta)
    this.agyAppDataDirRouting = this.agy && offersSessionArg(init._meta, AGY_APP_DATA_DIR_FLAG)
    this.appendsSystemPrompt = this.agy && takesSystemPromptAppend(result.version, caps)
    this.naming = mcpNaming(init.agentInfo)
    this.removal = hiddenRemoval(this.hooks.agentId, result.capabilities, result.version)
    this.subagents?.stop()
    this.subagents =
      this.agy && followsSubagents(result.version)
        ? new AgySubagents(
            this.hooks.agyStore ??
              agyStore(agyStoreFile(this.hooks.home), (parentId) => {
                const dir = this.agyAppDataDirOf(parentId)
                return dir ? agyStoreFile(this.hooks.home, dir) : undefined
              }),
            {
              target: (id) => this.targets.get(id),
              prompting: (id) => this.prompting.has(id),
              load: (childId, parentId, quiet) => this.loadSubagent(childId, parentId, quiet),
              settled: (id) => void this.switchPending(id),
              log: (level, message) => this.hooks.log(level, message),
            },
          )
        : null
    if (this.subagents) {
      const subagents = this.subagents
      void this.connection.closed.then(() => subagents.stop())
    }
    this.agyWait?.stop()
    this.agyWait =
      this.agy && steersAgy(result.version)
        ? new AgyBackgroundWait({
            tailReader:
              this.hooks.agyTailReader !== undefined
                ? this.hooks.agyTailReader
                : agyTailReader(this.hooks.home, (id) => this.agyAppDataDirOf(id)),
            settleMs: this.hooks.agyWaitSettleMs,
            fallbackMs: this.hooks.agyWaitFallbackMs,
            retryDelaysMs: this.hooks.agyWaitRetryDelaysMs,
            onWaitingChange: (sessionId, waiting) => {
              this.targets.get(sessionId)?.apply({
                patches: [],
                effects: [{ kind: 'waitingBackground', waiting }],
              })
            },
          })
        : null
    if (this.agyWait) {
      const wait = this.agyWait
      void this.connection.closed.then(() => wait.stop())
    }
    return result
  }

  /**
   * Opens one of agy's sub-agents in the process of the session that started it, with the servers
   * and folder of the session it all runs under, and the same tools allowed without asking.
   */
  private async loadSubagent(childId: string, parentId: string, quiet: boolean): Promise<void> {
    let root = parentId
    while (!this.agyOpened.has(root) && this.subagentParents.has(root)) {
      root = this.subagentParents.get(root)!
    }
    const opened = this.agyOpened.get(root)
    if (!opened) throw new Error(`${parentId} was not opened here`)
    this.subagentParents.set(childId, parentId)
    const allowed = this.autoAllowed.get(root)
    if (allowed) this.autoAllowed.set(childId, allowed)
    // The replay comes before the answer, and what agy sends after it is new.
    if (quiet) this.muted.add(childId)
    try {
      await this.call(() =>
        this.connection.agent.request(methods.agent.session.load, {
          sessionId: childId,
          cwd: opened.cwd,
          mcpServers: mcpServers(opened.options.mcpServers),
          _meta: { [PARENT_SESSION_META]: parentId },
        }),
      )
    } finally {
      this.muted.delete(childId)
    }
  }

  private meta(options: SessionOptions): Record<string, unknown> | undefined {
    return sessionMeta(this.hooks.agentId, options)
  }

  /** Resolved `app_data_dir` for a session (or its root parent for agy sub-agents), if non-default. */
  private agyAppDataDirOf(sessionId: string): string | undefined {
    return this.agyAppDataDirs.get(this.agyRootOf(sessionId))
  }

  /**
   * Resolves which `app_data_dir` owns an existing agy session and returns router `_meta` for
   * non-default stores (such as `'antigravity'` for imported IDE sessions). Never called for
   * `session/new`, which must stay in the default `'antigravity-cli'` store.
   */
  private async agySessionArgsMeta(
    sessionId: string,
    useCached = false,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.agy) return undefined
    let dir: string | null | undefined = useCached ? this.agyAppDataDirs.get(sessionId) : undefined
    if (dir === undefined) {
      try {
        dir = this.hooks.agyAppDataDir
          ? await this.hooks.agyAppDataDir(sessionId)
          : await resolveAgyAppDataDir(sessionId, this.hooks.home)
      } catch (error) {
        this.hooks.log(
          'warn',
          `Could not resolve agy app_data_dir for ${sessionId}: ${(error as Error).message}`,
        )
        dir = null
      }
      if (dir !== null && isSafeAgyAppDataDir(dir)) this.agyAppDataDirs.set(sessionId, dir)
      else this.agyAppDataDirs.delete(sessionId)
    }
    if (
      !this.agyAppDataDirRouting ||
      !dir ||
      dir === DEFAULT_AGY_APP_DATA_DIR ||
      !isSafeAgyAppDataDir(dir)
    ) {
      return undefined
    }
    return { [SESSION_ARGS_META]: { [AGY_APP_DATA_DIR_FLAG]: dir } }
  }

  private mergeMeta(
    ...parts: readonly (Record<string, unknown> | undefined)[]
  ): Record<string, unknown> | undefined {
    let out: Record<string, unknown> | undefined
    for (const part of parts) {
      if (!part) continue
      out = out ? { ...out, ...part } : { ...part }
    }
    return out && Object.keys(out).length > 0 ? out : undefined
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    const started = this.meta(options)
    const meta =
      this.appendsSystemPrompt && options.systemPromptAppend
        ? { ...started, ...systemPromptMeta(options.systemPromptAppend) }
        : started
    const open = (flagged: boolean) => {
      const sent = flagged ? { ...meta, [SESSION_FLAG_META]: true } : meta
      return this.call(() =>
        this.connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: mcpServers(options.mcpServers),
          ...(sent ? { _meta: sent } : {}),
        }),
      )
    }
    let full = this.fullAccess && options.fullAccess === true && !options.hidden
    let response: Awaited<ReturnType<typeof open>>
    try {
      response = await open(full)
    } catch (error) {
      if (!full) throw error
      // Opened without the flag, the session enters full access by a restart as its mode is set.
      this.hooks.log('warn', `agy did not start with full access: ${(error as Error).message}`)
      full = false
      response = await open(false)
    }
    this.readPlan(response._meta)
    this.allowWithoutAsking(response.sessionId, options)
    if (options.hidden && !promptsHidden(this.removal)) this.unprompted.add(response.sessionId)
    else {
      this.openedAgy(response.sessionId, cwd, options)
      this.agyMetrics?.onNewSession(response.sessionId)
    }
    return {
      sessionId: response.sessionId,
      config: this.opened(
        response.sessionId,
        cwd,
        options,
        this.config(response.configOptions, response.modes),
        full,
      ),
    }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const meta = this.mergeMeta(this.meta(options), await this.agySessionArgsMeta(sessionId))
    // The replay shows its sub-agents again, below.
    this.subagents?.forget(sessionId)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    this.readPlan(response._meta)
    this.allowWithoutAsking(sessionId, options)
    this.openedAgy(sessionId, cwd, options)
    this.agyMetrics?.onExistingSession(sessionId)
    await this.subagents?.replay(sessionId)
    return {
      config: this.opened(
        sessionId,
        cwd,
        options,
        this.config(response.configOptions, response.modes),
      ),
    }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const meta = this.mergeMeta(this.meta(options), await this.agySessionArgsMeta(sessionId))
    const open = (flagged: boolean) => {
      const sent = flagged ? { ...meta, [SESSION_FLAG_META]: true } : meta
      return this.call(() =>
        this.connection.agent.request(methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: mcpServers(options.mcpServers),
          ...(sent ? { _meta: sent } : {}),
        }),
      )
    }
    let full = this.fullAccess && options.fullAccess === true && !options.hidden
    let response: Awaited<ReturnType<typeof open>>
    try {
      response = await open(full)
    } catch (error) {
      if (!full) throw error
      // 带完全访问参数恢复失败时回退为普通恢复，由后续模式切换逻辑再处理。
      this.hooks.log('warn', `agy did not resume with full access: ${(error as Error).message}`)
      full = false
      response = await open(false)
    }
    this.readPlan(response._meta)
    this.allowWithoutAsking(sessionId, options)
    this.openedAgy(sessionId, cwd, options)
    this.agyMetrics?.onExistingSession(sessionId)
    // Its process started again, without the sub-agents it ran.
    this.subagents?.restarted(sessionId)
    return {
      config: this.opened(
        sessionId,
        cwd,
        options,
        this.config(response.configOptions, response.modes),
        full,
      ),
    }
  }

  /** Records the cwd and MCP servers for each agy session and discovers disk skills for tagging. */
  private openedAgy(sessionId: string, cwd: string, options: SessionOptions): void {
    if (!this.agy) return
    this.agyOpened.set(sessionId, { cwd, options })
    if (this.agySkillNames.has(cwd)) return
    const home = this.hooks.home ?? os.homedir()
    void scanAgySkillsOnDisk(cwd, home)
      .then((entries) => {
        const names = new Set(entries.map((entry) => entry.name))
        this.agySkillNames.set(cwd, names)
        if (names.size === 0 || this.isClosed) return
        for (const [id, raw] of this.agyRawCommands) {
          if (this.agyOpened.get(this.agyRootOf(id))?.cwd !== cwd) continue
          const target = this.targets.get(id)
          if (!target) continue
          target.apply({
            patches: [{ op: 'session.update', changes: { commands: mapCommands(raw, names) } }],
            effects: [],
          })
        }
      })
      .catch(() => {})
  }

  /**
   * `session/fork`, from ACP's unstable schema: a new session that starts from this one, up to
   * `point` for an agent with `forkAtMessage`.
   */
  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const meta = this.meta(options)
    const forkMeta = point ? { ...meta, ...forkPointMeta(point) } : meta
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(forkMeta ? { _meta: forkMeta } : {}),
      }),
    )
    this.allowWithoutAsking(response.sessionId, options)
    return {
      sessionId: response.sessionId,
      config: this.config(response.configOptions, response.modes),
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.session.close, { sessionId }))
    this.forgetSession(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call(() =>
      this.connection.agent.request(methods.agent.session.delete, { sessionId }),
    )
    this.forgetSession(sessionId)
  }

  private forgetSession(sessionId: string): void {
    this.autoAllowed.delete(sessionId)
    this.agyAccess.delete(sessionId)
    this.agyAppDataDirs.delete(sessionId)
    this.agySessionGrants.delete(sessionId)
    this.agyCommands.delete(sessionId)
    this.agyOpened.delete(sessionId)
    this.agyRawCommands.delete(sessionId)
    this.subagentParents.delete(sessionId)
    this.subagents?.forget(sessionId)
    this.agyMetrics?.forget(sessionId)
    this.agyWait?.forget(sessionId)
    this.chunkUsage.delete(sessionId)
    this.gooseCalls.delete(sessionId)
  }

  async listSessions(
    cwd: string | null,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    if (cwd === null) return { sessions: [], nextCursor: null }
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.list, {
        cwd,
        ...(cursor ? { cursor } : {}),
      }),
    )
    return {
      sessions: response.sessions.map((info) => ({
        sessionId: info.sessionId,
        title: info.title ?? null,
        updatedAt: info.updatedAt ?? null,
        cwd: info.cwd,
      })),
      nextCursor: response.nextCursor ?? null,
    }
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    // Prompted, it would stay in the agent's history after its removal.
    if (this.unprompted.has(sessionId)) {
      throw new Error(`${this.hooks.name ?? 'The agent'}'s hidden sessions are never prompted`)
    }
    await this.agyAccess.get(sessionId)?.restarting
    const planning = this.agy && plansAgy(this.version) && this.targets.has(sessionId)
    if (planning) {
      const plans = this.agyPlans.get(sessionId)
      this.agyPlans.set(sessionId, { calls: new Map(), written: null, last: plans?.last ?? null })
    }
    this.prompting.add(sessionId)
    this.agyWait?.onPromptStart(
      sessionId,
      this.targets.get(sessionId)?.context().thread.session.usage?.used ?? null,
    )
    this.chunkUsage.delete(sessionId)
    this.gooseCalls.delete(sessionId)
    let answer: ChainAnswer | null = null
    let chunked: TokenTotals | null
    let called: TokenTotals | null
    let failed = false
    try {
      await this.agyMetrics?.preparePrompt(sessionId)
      const sent = this.sendPrompt(sessionId, prompt)
      if (this.agy && steersAgy(this.version)) {
        const chain = new PromptChain(sent)
        this.chains.set(sessionId, chain)
        try {
          answer = await chain.settle()
        } finally {
          if (this.chains.get(sessionId) === chain) this.chains.delete(sessionId)
        }
      } else {
        const response = await sent
        answer = {
          response,
          tokens: mapTokenTotals(response.usage),
          models: mapModelUsage(response._meta),
        }
      }
    } catch (error) {
      failed = true
      throw error
    } finally {
      this.prompting.delete(sessionId)
      this.agyWait?.onPromptEnd(sessionId)
      chunked = this.chunkUsage.get(sessionId) ?? null
      this.chunkUsage.delete(sessionId)
      called = this.gooseCalls.get(sessionId)?.tokens ?? null
      this.gooseCalls.delete(sessionId)
      const aborted = failed || answer?.response.stopReason === 'cancelled'
      this.carryCommands(sessionId, aborted)
      this.subagents?.turnEnded(sessionId)
      await this.switchPending(sessionId)
    }
    const { response, tokens, models } = answer!
    const result: PromptResult = {
      stopReason: isStopReason(response.stopReason) ? response.stopReason : 'end_turn',
      // What the response reports wins, so a call is never counted from both; goose's response
      // holds only its latest call, so the sum of its calls wins there.
      tokens: (this.goose ? called : null) ?? tokens ?? (models.length === 0 ? chunked : null),
      models,
    }
    this.agyMetrics?.onPromptEnd(sessionId, result.stopReason)
    if (planning && result.stopReason === 'end_turn') await this.showPlan(sessionId)
    if (this.agy && result.stopReason === 'end_turn' && compactsAgy(this.version)) {
      if (sentCompact(prompt)) this.showCompaction(sessionId)
    }
    return result
  }

  private sendPrompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResponse> {
    return this.call(() =>
      this.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: contentBlocks(prompt),
      }),
    )
  }

  /**
   * Follows agy's commands in a session, and shows those that outlived their turn on its board
   * while they run on. Once the last ends, a full access switch that waited for it is made.
   */
  private noteCommand(sessionId: string, update: SessionUpdate, target: SessionTarget): void {
    if (!this.agy) return
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    if (target.context().replaying) return
    const inTurn = this.prompting.has(sessionId)
    let commands = this.agyCommands.get(sessionId)
    if (!commands) {
      if (!inTurn) return
      commands = new AgyCommands()
      this.agyCommands.set(sessionId, commands)
    }
    if (!commands.follow(update, inTurn, Date.now())) return
    this.showCommands(target, commands)
    if (!inTurn && !commands.running) void this.switchPending(sessionId)
  }

  /** The turn ended: the commands still running carry on, on the session board. */
  private carryCommands(sessionId: string, aborted = false): void {
    const commands = this.agyCommands.get(sessionId)
    const target = this.targets.get(sessionId)
    if (!commands || !target || !commands.turnEnded(aborted)) return
    this.showCommands(target, commands)
  }

  private showCommands(target: SessionTarget, commands: AgyCommands): void {
    target.apply({
      patches: [],
      effects: [
        { kind: 'tasks', tasks: commands.tasks() },
        { kind: 'backgroundRunning', running: commands.running, listed: false },
      ],
    })
  }

  /**
   * Whether one of agy's commands outlived its turn and runs on, or one of its sub-agents runs,
   * which a restart would stop.
   */
  private runsCommands(sessionId: string): boolean {
    return (
      this.agyCommands.get(sessionId)?.running === true ||
      this.subagents?.running(sessionId) === true
    )
  }

  /** The divider for a compaction agy ran without saying so, as the entry every agent gets. */
  private showCompaction(sessionId: string): void {
    const target = this.targets.get(sessionId)
    if (!target) return
    const ctx = target.context()
    const out: MapperOutput = { patches: [], effects: [] }
    addEntry(ctx, out, {
      kind: 'compaction',
      id: `c:${ctx.nextId()}`,
      status: 'completed',
      summary: '',
    })
    target.apply(out)
  }

  /** Notes a call of agy's that writes the session's plan, once it has written it. */
  private notePlanWrite(sessionId: string, update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const plans = this.agyPlans.get(sessionId)
    if (!plans || !this.prompting.has(sessionId)) return
    const file = plans.calls.get(update.toolCallId) ?? planWrite(update, sessionId, plans.last)
    if (file === null) return
    plans.calls.set(update.toolCallId, file)
    if (update.status === 'completed') plans.written = { toolCallId: update.toolCallId, file }
  }

  /**
   * Ends a Plan mode turn that wrote agy's plan with the plan, read from agy's file, as an entry
   * that the user is asked to approve once the turn is over.
   */
  private async showPlan(sessionId: string): Promise<void> {
    const plans = this.agyPlans.get(sessionId)
    const written = plans?.written
    const target = this.targets.get(sessionId)
    if (!plans || !written || !target?.readAgentFile) return
    plans.last = written.file
    const { config } = target.context().thread.session
    if (currentMode(config) !== PLAN_MODE) return
    const options = planOptions(config, [
      this.agyBuildModes.get(sessionId) ?? null,
      target.startMode(),
    ])
    if (!options) return
    const markdown = await target.readAgentFile(written.file)
    if (markdown === null || markdown.trim() === '' || this.targets.get(sessionId) !== target) {
      return
    }
    const ctx = target.context()
    // Its own entry: the call that wrote the file keeps its row when agy asked to write it.
    const entryId = `t:${written.toolCallId}#plan`
    const out: MapperOutput = { patches: [], effects: [] }
    addEntry(ctx, out, {
      kind: 'tool',
      id: entryId,
      title: t('antigravity.plan.title'),
      toolKind: 'switch_mode',
      status: 'completed',
      content: [{ type: 'markdown', markdown }],
      locations: [],
      permission: null,
      permissionResult: null,
      planVersion: planRevision(ctx.thread, entryId).version,
    })
    target.apply(out)
    const plan = { entryId, toolCallId: written.toolCallId, file: written.file, markdown, options }
    // The host ends the turn once the prompt has answered.
    setTimeout(() => void this.proposePlan(sessionId, target, plan), 0)
  }

  /**
   * Asks the user about agy's plan: build in a mode, which switches to it and sends what agy's
   * own terminal sends on approval, or keep planning in Plan mode with a note as the next message.
   */
  private async proposePlan(
    sessionId: string,
    target: SessionTarget,
    plan: AgyPlan,
  ): Promise<void> {
    // A turn that started meanwhile means the user went on without answering.
    if (this.targets.get(sessionId) !== target || this.isClosed || this.prompting.has(sessionId)) {
      return
    }
    let answer: PermissionAnswer
    try {
      answer = await target.requestPermission(
        {
          toolCallId: plan.toolCallId,
          toolEntryId: plan.entryId,
          output: { patches: [], effects: [] },
          options: plan.options,
          plan: plan.markdown,
        },
        // Nothing of agy's waits on the answer; the host settles the request when it must.
        new AbortController().signal,
      )
    } catch {
      return
    }
    const picked = optionAnswer(answer)
    if (picked === 'cancelled') return
    const mode = buildMode(picked.optionId)
    if (mode !== null) {
      try {
        const config = await this.setConfigOption(sessionId, MODE_OPTION, mode)
        target.apply({
          patches: [
            {
              op: 'session.update',
              changes: { config: mergeConfig(target.context().thread.session.config, config) },
            },
          ],
          effects: [],
        })
      } catch (error) {
        // The build still runs, in Plan mode, which asks before each change as Default does.
        this.hooks.log('warn', `Could not switch agy to ${mode}: ${(error as Error).message}`)
      }
      target.send(approved(plan.file), { approval: true })
    } else if (picked.optionId === KEEP_PLANNING && picked.note) {
      target.send(picked.note)
    }
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const messages: { id: string | null; text: string }[] = []
    this.pending.delete(sessionId)
    this.collectors.set(sessionId, (update) => {
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return
      const id = update.messageId ?? null
      const last = messages.at(-1)
      if (last && (id === null || last.id === id)) last.text += update.content.text
      else messages.push({ id, text: update.content.text })
    })
    try {
      await this.prompt(sessionId, [{ type: 'text', text }])
    } finally {
      this.collectors.delete(sessionId)
      this.unregister(sessionId)
    }
    return messages.map((message) => message.text)
  }

  /**
   * `_session/steering`: sends a message into the running turn. With `promptRequired`, an agent
   * with no turn running answers so instead of starting one, and the message stays Kettu's.
   */
  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    if (this.agy && steersAgy(this.version)) {
      // agy takes the message as a prompt of its own, which ends the one before it.
      const chain = this.chains.get(sessionId)
      if (!chain) return 'promptRequired'
      const before = this.agyWait?.generationOf(sessionId)
      const outcome = await chain.steer(() => this.sendPrompt(sessionId, prompt))
      if (outcome === 'injected') this.agyWait?.onSteered(sessionId, before)
      return outcome
    }
    const response = await this.call(() =>
      this.connection.agent.request<{ outcome?: unknown }>('_session/steering', {
        sessionId,
        prompt: contentBlocks(prompt),
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      }),
    )
    if (response?.outcome === 'injected' || response?.outcome === 'promptRequired') {
      return response.outcome
    }
    throw new AgentRequestError(
      'agent_error',
      `Unexpected steering outcome ${JSON.stringify(response?.outcome)}`,
    )
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call(() => this.connection.agent.notify(methods.agent.session.cancel, { sessionId }))
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.call(() =>
      this.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId }),
    )
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const access = this.agyAccess.get(sessionId)
    if (access) {
      await access.restarting
    }
    if (this.agy && optionId === MODE_OPTION && value === PLAN_MODE) {
      const mode =
        this.agyMode(sessionId) ??
        currentMode(this.targets.get(sessionId)?.context().thread.session.config ?? [])
      if (mode !== null && mode !== PLAN_MODE) this.agyBuildModes.set(sessionId, mode)
    }
    if (access && optionId === MODE_OPTION && typeof value === 'string') {
      // 进入或退出完全访问（或取消挂起中的完全访问切换）需要走 switchAccess 逻辑。
      if ((this.fullAccess && value === FULL_ACCESS) || access.full || access.pending !== null) {
        const switched = await this.switchAccess(sessionId, access, value)
        if (switched) return switched
      }
      // 切入 Kettu 托管 Auto 模式：底层 agy 保持 default，由 Kettu 统一做风险评估与审批拦截。
      if (value === AUTO_MODE) {
        let base = access.config
        if (access.rawMode !== HELD_MODE) {
          base = await this.requestConfig(sessionId, MODE_OPTION, HELD_MODE)
          access.rawMode = currentMode(base) ?? HELD_MODE
        }
        access.managedAuto = true
        access.config = this.formatAgyConfig(base, access, this.pendingState(sessionId, access))
        return access.config
      }
      // 从托管 Auto 切回 default：底层已在 default 时无需冗余 RPC，直接还原展示值。
      if (value === HELD_MODE && access.managedAuto && access.rawMode === HELD_MODE) {
        access.managedAuto = false
        access.config = this.formatAgyConfig(
          withModeValue(access.config, HELD_MODE),
          access,
          this.pendingState(sessionId, access),
        )
        return access.config
      }
      access.managedAuto = false
    }
    const config = await this.requestConfig(sessionId, optionId, value)
    if (!access) return config
    access.rawMode = currentMode(config) ?? access.rawMode
    access.config = this.formatAgyConfig(config, access, this.pendingState(sessionId, access))
    return access.config
  }

  private async requestConfig(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const response = await this.call(() =>
      this.connection.agent.request(
        methods.agent.session.setConfigOption,
        typeof value === 'boolean'
          ? { sessionId, configId: optionId, type: 'boolean', value }
          : { sessionId, configId: optionId, value },
      ),
    )
    return this.config(response.configOptions, null)
  }

  // agy 的托管模式与完全访问切换。

  /** 按当前托管状态组装展示给 UI 的 agy 配置列表。 */
  private formatAgyConfig(
    config: readonly ConfigOption[],
    access: Pick<AgyAccess, 'full' | 'managedAuto'>,
    pending: PendingConfig | null = null,
  ): ConfigOption[] {
    return withAgyModes(config, {
      full: access.full,
      managedAuto: access.managedAuto,
      includeFull: this.fullAccess,
      pending,
    })
  }

  /** 计算当前会话在完全访问切换上的挂起/重启状态。 */
  private pendingState(sessionId: string, access: AgyAccess): PendingConfig | null {
    if (access.switching !== null) return { value: access.switching, wait: 'restarting' }
    if (access.pending !== null) {
      return {
        value: access.pending,
        wait: this.prompting.has(sessionId) ? 'turn' : 'background',
      }
    }
    return null
  }

  /**
   * 记录刚打开的 agy 会话状态，并按托管策略补齐 Auto 与完全访问模式选项。
   */
  private opened(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
    config: ConfigOption[],
    full = false,
  ): ConfigOption[] {
    if (!this.agy) return config
    const rawMode = currentMode(config)
    const state = { full, managedAuto: false }
    const shown = this.formatAgyConfig(config, state)
    this.agyAccess.set(sessionId, {
      cwd,
      options,
      full,
      managedAuto: false,
      rawMode,
      config: shown,
      pending: null,
      switching: null,
      restarting: null,
    })
    return shown
  }

  /** 将 agy 上报的配置更新合并上托管 Auto、完全访问选项与挂起状态，避免被底层 default 覆盖。 */
  private withAccess(sessionId: string, out: MapperOutput): MapperOutput {
    const access = this.agyAccess.get(sessionId)
    if (!access) return out
    const pending = this.pendingState(sessionId, access)
    for (const patch of out.patches) {
      if (patch.op !== 'session.update' || !patch.changes.config) continue
      // 重启进程期间 agy 会在 session/resume 完成前推送 default 模式，保持重启前模式值与 restarting 提示。
      if (access.switching !== null) {
        const keptMode = currentMode(access.config)
        const stabilized =
          keptMode !== null && !access.full
            ? withModeValue(patch.changes.config, keptMode)
            : patch.changes.config
        patch.changes.config = this.formatAgyConfig(stabilized, access, pending)
        continue
      }
      access.rawMode = currentMode(patch.changes.config) ?? access.rawMode
      access.config = this.formatAgyConfig(patch.changes.config, access, pending)
      patch.changes.config = access.config
    }
    return out
  }

  /**
   * 处理支持完全访问的 agy 会话模式切换：空闲时立即重启进程，有回合或后台任务时挂起并返回待切换状态。
   */
  private async switchAccess(
    sessionId: string,
    access: AgyAccess,
    mode: string,
  ): Promise<ConfigOption[] | null> {
    const full = mode === FULL_ACCESS
    if (full === access.full) {
      const hadPending = access.pending !== null
      access.pending = null
      if (full) {
        access.config = this.formatAgyConfig(access.config, access)
        return access.config
      }
      // 取消之前挂起的完全访问切换（重新选中当前已生效模式）时直接清掉 pending，无需再发 RPC。
      if (hadPending && currentMode(access.config) === mode) {
        access.config = this.formatAgyConfig(access.config, access)
        return access.config
      }
      return null
    }
    // 重启会中断当前回合以及跨回合运行的后台命令或子智能体，挂起并向界面同步等待原因。
    if (this.prompting.has(sessionId) || this.runsCommands(sessionId)) {
      access.pending = mode
      access.config = this.formatAgyConfig(
        access.config,
        access,
        this.pendingState(sessionId, access),
      )
      return access.config
    }
    access.pending = null
    return this.restartAgy(sessionId, access, full, mode)
  }

  /**
   * 在回合或后台任务结束后执行挂起的模式切换；若仍被后台任务阻塞则刷新等待原因，失败时回滚并通知。
   */
  private async switchPending(sessionId: string): Promise<void> {
    const access = this.agyAccess.get(sessionId)
    const mode = access?.pending
    if (!access || !mode) return
    if (this.prompting.has(sessionId) || this.runsCommands(sessionId)) {
      const next = this.pendingState(sessionId, access)
      const prev = access.config.find((option) => option.id === MODE_OPTION)?.pending
      if (next && (prev?.wait !== next.wait || prev?.value !== next.value)) {
        access.config = this.formatAgyConfig(access.config, access, next)
        this.targets.get(sessionId)?.apply({
          patches: [{ op: 'session.update', changes: { config: access.config } }],
          effects: [],
        })
      }
      return
    }
    access.pending = null
    const full = mode === FULL_ACCESS
    if (full === access.full || this.isClosed) return
    try {
      const config = await this.restartAgy(sessionId, access, full, mode)
      this.targets.get(sessionId)?.apply({
        patches: [{ op: 'session.update', changes: { config } }],
        effects: [],
      })
    } catch (error) {
      const message = (error as Error).message
      this.hooks.log('warn', `Could not switch agy session ${sessionId} to ${mode}: ${message}`)
      const target = this.targets.get(sessionId)
      if (!target) return
      const ctx = target.context()
      const out: MapperOutput = {
        patches: [{ op: 'session.update', changes: { config: access.config } }],
        effects: [],
      }
      addEntry(ctx, out, {
        kind: 'notice',
        id: ctx.nextId(),
        severity: 'error',
        title: t(
          full ? 'antigravity.fullAccess.enterFailed' : 'antigravity.fullAccess.leaveFailed',
        ),
        description: message,
        after: agentEntryBefore(ctx.thread),
      })
      target.apply(out)
    }
  }

  /**
   * 重启 agy 进程以进入或退出完全访问并恢复其余配置；重启期间推送 restarting 提示，失败时回滚。
   */
  private async restartAgy(
    sessionId: string,
    access: AgyAccess,
    full: boolean,
    mode: string,
  ): Promise<ConfigOption[]> {
    const before = {
      full: access.full,
      managedAuto: access.managedAuto,
      rawMode: access.rawMode,
      config: this.formatAgyConfig(access.config, access),
    }
    const was = currentMode(before.config)
    access.switching = mode
    this.targets.get(sessionId)?.apply({
      patches: [
        {
          op: 'session.update',
          changes: {
            config: this.formatAgyConfig(before.config, before, {
              value: mode,
              wait: 'restarting',
            }),
          },
        },
      ],
      effects: [],
    })
    const run = this.resumeAgy(sessionId, access, full, mode, before.config)
      .then((config) => {
        access.switching = null
        return config
      })
      .catch(async (error: unknown) => {
        try {
          access.config = await this.resumeAgy(
            sessionId,
            access,
            before.full,
            was === null || was === FULL_ACCESS ? HELD_MODE : was,
            before.config,
          )
        } catch {
          access.full = before.full
          access.managedAuto = before.managedAuto
          access.rawMode = before.rawMode
          access.config = before.config
        } finally {
          access.switching = null
        }
        this.targets.get(sessionId)?.apply({
          patches: [{ op: 'session.update', changes: { config: access.config } }],
          effects: [],
        })
        throw this.toError(error)
      })
    const restarting = run.then(
      () => {},
      () => {},
    )
    access.restarting = restarting
    try {
      return await run
    } finally {
      if (access.restarting === restarting) access.restarting = null
    }
  }

  private async resumeAgy(
    sessionId: string,
    access: AgyAccess,
    full: boolean,
    mode: string,
    values: readonly ConfigOption[],
  ): Promise<ConfigOption[]> {
    const meta = this.mergeMeta(
      this.meta(access.options),
      await this.agySessionArgsMeta(sessionId, true),
      full ? { [SESSION_FLAG_META]: true } : undefined,
    )
    const response = await this.connection.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd: access.cwd,
      mcpServers: mcpServers(access.options.mcpServers),
      ...(meta ? { _meta: meta } : {}),
    })
    const managedAuto = !full && mode === AUTO_MODE
    access.full = full
    access.managedAuto = managedAuto
    this.subagents?.restarted(sessionId)
    this.readPlan(response._meta)
    this.allowWithoutAsking(sessionId, access.options)
    let config = this.config(response.configOptions, response.modes)
    for (const option of restoreOrder(values)) {
      if (!lacks(config, option)) continue
      try {
        config = await this.requestConfig(sessionId, option.id, option.value)
      } catch (error) {
        this.hooks.log(
          'warn',
          `agy session ${sessionId} kept ${option.id} after a restart: ${(error as Error).message}`,
        )
      }
    }
    const wanted = full || managedAuto ? HELD_MODE : mode
    if (currentMode(config) !== wanted) {
      config = await this.requestConfig(sessionId, MODE_OPTION, wanted)
    }
    access.rawMode = currentMode(config) ?? wanted
    access.config = this.formatAgyConfig(config, access)
    return access.config
  }

  async authenticate(methodId: string, client?: SignInClient): Promise<void> {
    const options = client
      ? { cancellationSignal: client.signal, stopWaitingOnCancel: true }
      : undefined
    const request = (meta?: Record<string, unknown>) =>
      this.call(() =>
        this.connection.agent.request(
          methods.agent.authenticate,
          meta ? { methodId, _meta: meta } : { methodId },
          options,
        ),
      )
    this.signIn = client ?? null
    try {
      if (methodId !== DELEGATED_SIGN_IN || !client) {
        this.readPlan((await request())._meta)
        return
      }
      // Mistral Vibe: `start` answers with the page and an attempt; `complete` waits for the
      // browser to finish it.
      const started = delegatedSignInStart(await request({ action: 'start' }))
      if (!started) throw new AgentRequestError('agent_error', t('agent.noSignInPage'))
      client.openLink(started.url)
      await request({ action: 'complete', attemptId: started.attemptId })
    } finally {
      if (this.signIn === client) this.signIn = null
      for (const [id, signIn] of this.signInRequests) {
        if (signIn === client) this.signInRequests.delete(id)
      }
    }
  }

  async readAuthStatus(): Promise<void> {
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.auth.status, {}),
    )
    const status = mapReportedAuthStatus(response)
    if (!status) {
      this.hooks.ignored(null, 'auth/status with an unknown shape')
      return
    }
    this.hooks.authState?.(status.state)
    if (status.account) this.hooks.account(status.account)
  }

  /**
   * Google Antigravity names its plan in the `_meta` of its sign-in's and sessions' answers while
   * signed in with Google, and none on an API key or a cloud project; the plan's id shows which
   * Google sign-in it is.
   */
  private readPlan(meta: unknown): void {
    if (this.hooks.agentId !== 'antigravity') return
    if (this.version === null || compareVersions(this.version, ANTIGRAVITY_TIER_VERSION) < 0) return
    const plan = antigravityTier(meta)
    const tier = antigravityTierMultiple(meta)
    if (plan) {
      this.hooks.account({
        kind: 'account',
        label: plan,
        email: null,
        ...(tier ? { tier } : {}),
      })
    }
    this.hooks.signInShown?.(plan ? antigravityTierSignIn(meta) : null)
  }

  async logout(): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.logout, {}))
  }

  /** Sends a vendor-specific ACP extension request on this connection. */
  async request<T>(method: string, params?: unknown): Promise<T> {
    return this.call(() => this.connection.agent.request(method, params ?? {})) as Promise<T>
  }

  get hiddenSessions(): boolean {
    return promptsHidden(this.removal)
  }

  get unpromptedSessions(): boolean {
    return this.removal !== null
  }

  /** agy asks for every MCP tool, and Kettu answers for those it allows; other agents ask the user. */
  get allowsKettuTools(): boolean {
    return this.agy
  }

  async removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    this.unregister(sessionId)
    this.unprompted.delete(sessionId)
    const removal = this.removal
    if (!removal) return
    const failed = (error: unknown): void => {
      if (!this.isClosed) log((error as Error).message)
    }
    if (removal === 'close' || removal === 'close-unprompted') {
      await this.closeSession(sessionId).catch(failed)
      return
    }
    await this.deleteSession(sessionId).catch(failed)
    for (const delay of removal === 'delete-again' ? DELETE_AGAIN_MS : []) {
      setTimeout(() => void this.deleteSession(sessionId).catch(failed), delay).unref()
    }
  }
}

/** 返回将 `mode` 选项值覆盖为 `mode` 后的配置副本。 */
function withModeValue(config: readonly ConfigOption[], mode: string): ConfigOption[] {
  return config.map((option) =>
    option.id === MODE_OPTION && option.type === 'select' ? { ...option, value: mode } : option,
  )
}

/** The `sessionUpdate` of a `session/update` notification the SDK does not know, or null. */
function unknownVariant(message: AnyMessage): string | null {
  if (!('method' in message) || message.method !== 'session/update' || 'id' in message) return null
  const params = message.params as { update?: { sessionUpdate?: unknown } } | undefined
  const variant = params?.update?.sessionUpdate
  if (typeof variant !== 'string') return null
  return KNOWN_UPDATES.has(variant) ? null : variant
}
