// The artifacts service: the `kettu` MCP server on 127.0.0.1, which each attached session
// reaches with a token of its own, or for OpenCode with its process and folder's token. Streamable
// HTTP in plain JSON, one stateless transport per request.

import {
  DEVICE_AUTO_MODE_TOOLS,
  DEVICE_READ_TOOLS,
  DEVICE_TOOLS,
  DeviceTools,
  isDeviceToolName,
  type DeviceToolDeps,
} from '../devices/tools'
import {
  callGuide,
  GUIDE_TOOL,
  guidePrompt,
  guideTool,
  serviceInstructions,
  type GuideFlags,
  type GuideTopic,
} from '../guide/guide'
import {
  isTerminalToolName,
  TERMINAL_AUTO_MODE_TOOLS,
  TERMINAL_READ_TOOLS,
  TERMINAL_TOOLS,
  TerminalTools,
  type TerminalToolDeps,
} from '../terminals/tools'
import { addLogSecret } from '@shared/log/process-log'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { BrowserCallAnswer, BrowserCallRequest } from '@shared/browser'
import { isComputerToolName } from '@shared/computer-use'
import type { McpServer } from '../connection'
import { BRIDGE_PREFIX, BRIDGE_UPGRADE, McpRouter, type RouterCaller } from '../mcp-router/router'
import type { Duplex } from 'node:stream'
import type { McpToolGroup, McpToolSummary } from '@shared/agent-host'
import type { MarketServer } from '@shared/marketplace'
import {
  isMarketToolName,
  MARKET_AUTO_ALLOW,
  MARKET_PUBLISH,
  MARKET_TOOLS,
  MARKET_UNLIST,
  type MarketTools,
} from '../marketplace/publish-tools'
import { SERVICE_NAME } from '../service-name'
import {
  described,
  FIND_TOOL,
  findTools,
  type Findable,
  GATEWAY_TOOL,
  gatewayInput,
  gatewayList,
  topicTools,
  unknownTool,
  withArguments,
} from '../tool-gateway'
import {
  CHANGE_SETTINGS,
  isSettingsToolName,
  SETTINGS_TOOL_NAMES,
  SETTINGS_TOOLS,
  type SettingsTools,
} from '../settings/tools'
import {
  isRoutineToolName,
  ROUTINE_ASKING_TOOLS,
  ROUTINE_TOOL_NAMES,
  ROUTINE_TOOLS,
  type RoutineTools,
} from '../routines/tools'
import {
  isMcpToolName,
  MCP_ASKING_TOOLS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpTools,
} from '../marketplace/mcp-tools'
import type { LogFn } from '../storage'
import {
  SessionTools,
  isSessionToolName,
  SESSION_TOOLS,
  type SessionToolsDeps,
} from '../session-tools'
import {
  BrowserTools,
  BROWSER_AUTO_MODE_TOOLS,
  BROWSER_READ_TOOLS,
  BROWSER_TOOLS,
  isBrowserToolName,
  type BrowserAccessDeps,
} from './browser-tools'
import {
  isPlanToolName,
  PlanTools,
  PLAN_PROMPT,
  PLAN_TOOL,
  PLAN_TOOLS,
  type PlanToolsDeps,
} from '../plan-tool'
import {
  isSuggestToolName,
  SUGGEST_PROMPT,
  SUGGEST_TOOL,
  SUGGEST_TOOLS,
  SuggestTools,
  type SuggestToolsDeps,
} from '../next-message'
import {
  isWorkflowToolName,
  WORKFLOW_TOOL_NAMES,
  WORKFLOW_TOOLS,
  WorkflowTools,
  type WorkflowToolsDeps,
} from '../workflow/tools'
import {
  isReportToolName,
  REPORT_TOOL,
  REPORT_TOOLS,
  ReportTools,
  type ReportToolsDeps,
} from '../report-tool'
import { COMPUTER_AUTO_MODE_TOOLS, COMPUTER_READ_TOOLS, COMPUTER_TOOLS } from '../computer/tools'
import {
  isMemoryToolName,
  MEMORY_TOOL_NAMES,
  MEMORY_TOOLS,
  MemoryTools,
  type MemoryToolsDeps,
} from '../memory/tools'
import {
  isSkillToolName,
  SKILL_TOOL_NAMES,
  SKILL_TOOLS,
  SkillTools,
  type SkillToolsDeps,
} from '../marketplace/skill-tools'
import { isPluginToolName } from '@shared/plugins'
import type { PluginTools } from '../plugin-runtime/tools'
import { artifactWrite, type ArtifactWrite } from './entries'
import type { ArtifactData } from './runtime/data'
import { DATA_READ_TOOLS, DATA_TOOLS, DataTools, isDataToolName } from './runtime/data-tools'
import {
  ARTIFACT_AUTO_MODE_TOOLS,
  ARTIFACT_READ_TOOLS,
  ArtifactTools,
  isToolName,
  TOOLS,
  type ArtifactToolsDeps,
  type Caller,
} from './tools'

export { SERVICE_NAME }
export const SERVICE_PATH = '/mcp'
/** A call may carry several files of up to 5 MiB of text each, escaped as JSON. */
export const BODY_BYTES = 16 * 1024 * 1024
const TOKEN_BYTES = 32
/** A tool's description in Settings: its first sentence, at most this many characters. */
const SUMMARY_CHARS = 200
/** Where OpenCode names the calling session on each `tools/call`, a subagent's own included. */
const SESSION_META = 'ai.opencode/sessionID'

/** The tools `tools/list` always answers: the artifact tools, the session tools and the browser's. */
const SERVICE_TOOLS: Tool[] = [
  ...TOOLS,
  ...DATA_TOOLS,
  ...SESSION_TOOLS,
  ...PLAN_TOOLS,
  ...REPORT_TOOLS,
  ...BROWSER_TOOLS,
  ...DEVICE_TOOLS,
  ...TERMINAL_TOOLS,
]

/** The group each of Kettu's tools is listed in on its server's page in the Marketplace. */
const TOOL_GROUPS: ReadonlyMap<string, McpToolGroup> = new Map(
  (
    [
      [MARKET_TOOLS, 'marketplace'],
      [SESSION_TOOLS, 'sessions'],
      [PLAN_TOOLS, 'sessions'],
      [SUGGEST_TOOLS, 'sessions'],
      [TOOLS, 'artifacts'],
      [DATA_TOOLS, 'artifacts'],
      [BROWSER_TOOLS, 'browser'],
      [COMPUTER_TOOLS, 'computer'],
      [DEVICE_TOOLS, 'devices'],
      [TERMINAL_TOOLS, 'terminal'],
      [MEMORY_TOOLS, 'memory'],
      [REPORT_TOOLS, 'reports'],
      [WORKFLOW_TOOLS, 'workflows'],
      [SETTINGS_TOOLS, 'settings'],
      [ROUTINE_TOOLS, 'routines'],
      [MCP_TOOLS, 'mcp'],
    ] as const
  )
    .flatMap(([tools, group]) => tools.map((tool) => [tool.name, group] as const))
    .concat([[GUIDE_TOOL, 'sessions']]),
)
/** The group of tools each guide topic is about, for the tools it lists to call by the gateway. */
const TOPIC_GROUPS: Partial<Record<GuideTopic, McpToolGroup>> = {
  artifacts: 'artifacts',
  sessions: 'sessions',
  workflows: 'workflows',
  browser: 'browser',
  devices: 'devices',
  terminals: 'terminal',
  computer: 'computer',
  marketplace: 'marketplace',
  settings: 'settings',
  routines: 'routines',
  mcp: 'mcp',
}
/** The tools that wait for the user's answer in the session before they act. */
const ASKING_TOOLS: ReadonlySet<string> = new Set([
  MARKET_PUBLISH,
  MARKET_UNLIST,
  CHANGE_SETTINGS,
  ...ROUTINE_ASKING_TOOLS,
  ...MCP_ASKING_TOOLS,
])

/** Serves the computer use tools, on a host that carries the driver. */
export interface ComputerCalls {
  call(sessionId: string, name: string, input: unknown): Promise<CallToolResult>
}

// The SDK loads with the first request rather than with the host, which starts faster without it.
function loadSdk() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([server, transport, types]) => ({ ...server, ...transport, ...types }))
}

type Sdk = Awaited<ReturnType<typeof loadSdk>>

/** An agent process that keeps one server of a name per folder, such as OpenCode's. */
export interface AgentProcess {
  /** Settles when the process exits, which ends its tokens. */
  readonly closed: Promise<void>
}

export interface ArtifactServiceDeps extends ArtifactToolsDeps {
  log: LogFn
  appVersion: string
  /** The session manager behind the session tools. */
  sessions: SessionToolsDeps
  /**
   * The session in memory that a call of `process` names, a subagent's counting as the session
   * it runs under; null for an id Kettu does not have.
   */
  sessionOf(process: AgentProcess, id: string): string | null
  /** A call of the session's, or of a subagent of it, wrote to an artifact. */
  wrote?(sessionId: string, write: ArtifactWrite): void
  /** Runs a browser tool call of `caller`'s on main; without it every `browser_*` call fails. */
  browserCall?(request: BrowserCallRequest, caller: string): Promise<BrowserCallAnswer>
  /** How a browser tab the user opened is allowed for the agent. */
  browserAccess?: BrowserAccessDeps
  /** The session whose browser a call drives: a subagent's use the session it runs under. */
  browserSession?(sessionId: string): string | null
  /** The project whose always-allowed sites the page reads. */
  sessionProject?(sessionId: string): string | null
  /** The folder the session works in, its worktree's or its project's, for the files it names. */
  sessionFolder?(sessionId: string): string | null
  /** The artifacts' data, which the data tools read and write; without it they fail. */
  data?: ArtifactData
  /** Where the plan tool writes. */
  plan: PlanToolsDeps
  /** Where the problem report tool adds its drafts. */
  report: ReportToolsDeps
  /**
   * Where the next-message tool keeps a turn's suggestion, which only the sessions that suggest by
   * it are listed; without it none is.
   */
  suggest?: SuggestToolsDeps
  /** Kettu's memory behind the memory tools, listed only while it is on; without it none. */
  memory?: MemoryToolsDeps
  /** Whether the agent's session `id` is a subagent that runs under a session of its own. */
  subagentCall?(process: AgentProcess, id: string): boolean
  /** The mobile devices behind the `device_*` tools; without them every call fails. */
  devices?: Omit<DeviceToolDeps, 'sessionOf' | 'projectOf'>
  /** The terminal host behind the `terminal_*` tools; without it every call fails. */
  terminals?: Omit<TerminalToolDeps, 'sessionOf' | 'folderOf'>
  /** The computer use tools; without it the service lists none. */
  computer?: ComputerCalls
  /** The workflow tools; without them the service lists none. */
  workflow?: WorkflowToolsDeps
  /**
   * The Marketplace tools, listed only while the host is signed in to a Kettu account with Kettu's
   * services on; without them none.
   */
  market?: MarketTools
  /** Kettu's settings tools; without them the service lists none. */
  settings?: SettingsTools
  /** The Routine tools of the host's Routines; without them the service lists none. */
  routines?: RoutineTools
  /** The tools of the host's MCP library; without them the service lists none. */
  mcp?: McpTools
  /** The tools the plugins that are on give agents; without it the service lists none. */
  plugins?: PluginTools
  /** The skills behind the skill tools, which only an agent that loads no skill folders gets. */
  skills?: SkillToolsDeps
  /** The Marketplace's servers, each under a path of its own; without it none. */
  router?: Pick<McpRouter, 'handle' | 'upgrade' | 'forget' | 'tools' | 'call'>
  /** The library's servers by id, for the gateway's calls to the ones behind it. */
  libraryServer?(serverId: string): MarketServer | null
}

/** A token for one session. */
interface SessionGrant {
  token: string
  project: string
  sessionId: string
  /** Reaches Kettu's own server too, not only the library's: Kettu's server is on for its agent. */
  own: boolean
  /** Lists the core tools and the gateway to the rest, for an agent that drops tools. */
  gateway: boolean
  /** Lists the next-message tool, for an agent that suggests by it. */
  suggests: boolean
  /** The library servers handed to the session, which the token reaches, by id. */
  servers: Set<string>
  /** Those of them behind the gateway rather than declared, for an agent that drops tools. */
  gated: Set<string>
}

/** A token for one agent process and folder, whose calls name their session in `_meta`. */
interface FolderGrant {
  token: string
  project: string
  process: AgentProcess
  /** The sessions in memory that attached through it. */
  sessions: Set<string>
  own: boolean
  gateway: boolean
  suggests: boolean
  servers: Set<string>
  gated: Set<string>
}

type Grant = SessionGrant | FolderGrant

function newToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  addLogSecret(token)
  return token
}

function entry(url: string, token: string, prompt: string): McpServer[] {
  return [
    {
      type: 'http',
      name: SERVICE_NAME,
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      // Kettu 内置安全只读及自带内部确认卡的工具：在所有模式下自动放行，不重复弹出 Agent 权限卡。
      autoAllow: [
        PLAN_TOOL,
        SUGGEST_TOOL,
        ...ARTIFACT_READ_TOOLS,
        ...DATA_READ_TOOLS,
        ...TERMINAL_READ_TOOLS,
        ...BROWSER_READ_TOOLS,
        ...DEVICE_READ_TOOLS,
        ...COMPUTER_READ_TOOLS,
        REPORT_TOOL,
        GUIDE_TOOL,
        FIND_TOOL,
        ...SKILL_TOOL_NAMES,
        ...MEMORY_TOOL_NAMES,
        ...SESSION_TOOLS.map((tool) => tool.name),
        ...WORKFLOW_TOOL_NAMES,
        ...MARKET_AUTO_ALLOW,
        ...SETTINGS_TOOL_NAMES,
        ...ROUTINE_TOOL_NAMES,
        ...MCP_TOOL_NAMES,
      ],
      // 仅在 Auto 权限模式下自动放行的可回滚内置工具（不可逆删除、高危终端命令、桌面点击/键入与插件工具仍需确认）。
      autoModeAllow: [
        ...ARTIFACT_AUTO_MODE_TOOLS,
        ...BROWSER_AUTO_MODE_TOOLS,
        ...DEVICE_AUTO_MODE_TOOLS,
        ...TERMINAL_AUTO_MODE_TOOLS,
        ...COMPUTER_AUTO_MODE_TOOLS,
      ],
      prompt,
      secret: true,
    },
  ]
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A tool's description up to its first ". ", cut at a word past `SUMMARY_CHARS`. */
export function firstSentence(text: string, limit = SUMMARY_CHARS): string {
  const end = text.indexOf('. ')
  const sentence = end === -1 ? text : text.slice(0, end + 1)
  if (sentence.length <= limit) return sentence
  const cut = sentence.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return space > 0 ? cut.slice(0, space) : cut
}

function refuse(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

export class ArtifactService {
  private server: http.Server | null = null
  private port: number | null = null
  /** The live tokens by their SHA-256, so a lookup compares no secret byte by byte. */
  private readonly grants = new Map<string, Grant>()
  /** The token each session attached with, by its digest. */
  private readonly sessions = new Map<string, string>()
  /** Each agent process's folder tokens by folder, kept until the process exits. */
  private readonly folders = new Map<AgentProcess, Map<string, string>>()
  private readonly tools: ArtifactTools
  private readonly sessionTools: SessionTools
  private readonly planTools: PlanTools
  private readonly reportTools: ReportTools
  private readonly suggestTools: SuggestTools | null
  private readonly memoryTools: MemoryTools | null
  private readonly browserTools: BrowserTools
  private readonly deviceTools: DeviceTools | null
  private readonly terminalTools: TerminalTools | null
  private readonly dataTools: DataTools | null
  private readonly workflowTools: WorkflowTools | null
  private readonly skillTools: SkillTools | null
  private sdk: Promise<Sdk> | null = null
  /** Why the last `start()` could not listen; cleared once it does. */
  private startError: string | null = null
  private readonly serviceTools: Tool[]

  constructor(private readonly deps: ArtifactServiceDeps) {
    this.tools = new ArtifactTools(deps)
    this.dataTools = deps.data ? new DataTools({ data: deps.data }) : null
    this.sessionTools = new SessionTools(deps.sessions)
    this.planTools = new PlanTools(deps.plan)
    this.reportTools = new ReportTools(deps.report)
    this.suggestTools = deps.suggest ? new SuggestTools(deps.suggest) : null
    this.memoryTools = deps.memory ? new MemoryTools(deps.memory) : null
    this.workflowTools = deps.workflow ? new WorkflowTools(deps.workflow) : null
    this.skillTools = deps.skills ? new SkillTools(deps.skills) : null
    this.serviceTools = deps.computer ? [...SERVICE_TOOLS, ...COMPUTER_TOOLS] : SERVICE_TOOLS
    const browserCall = deps.browserCall
    this.browserTools = new BrowserTools({
      call: (request, caller) =>
        browserCall
          ? browserCall(request, caller)
          : Promise.resolve({
              error: {
                code: 'no_page',
                message: 'This build drives no browser. Use the user’s own browser instead.',
              },
            }),
      pageOf: (sessionId) => deps.browserSession?.(sessionId) ?? sessionId,
      projectOf: (sessionId) => deps.sessionProject?.(sessionId) ?? '',
      ...(deps.browserAccess ? { access: deps.browserAccess } : {}),
    })
    const devices = deps.devices
    this.deviceTools = devices
      ? new DeviceTools({
          ...devices,
          sessionOf: (sessionId) => deps.browserSession?.(sessionId) ?? sessionId,
          projectOf: (sessionId) =>
            deps.sessionFolder?.(sessionId) ?? deps.sessionProject?.(sessionId) ?? null,
        })
      : null
    const terminals = deps.terminals
    this.terminalTools = terminals
      ? new TerminalTools({
          ...terminals,
          sessionOf: (sessionId) => deps.browserSession?.(sessionId) ?? sessionId,
          folderOf: (sessionId) =>
            deps.sessionFolder?.(sessionId) ?? deps.sessionProject?.(sessionId) ?? null,
        })
      : null
  }

  /** Takes back a session's allow for a device; its agent's next use of it asks again. */
  revokeDevice(sessionId: string, deviceId: string): void {
    this.deviceTools?.revoke(sessionId, deviceId)
  }

  /** `host:browser-waiting`: the call waits on a new origin, so its own limit grows to that wait. */
  browserWaiting(callId: number, waiting: boolean): void {
    this.browserTools.browserWaiting(callId, waiting)
  }

  /** Listens on a port the system picks; without it, sessions attach with no service. */
  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.deps.log('error', `The artifacts service failed: ${(error as Error).message}`)
        if (!res.headersSent) refuse(res, 500, 'The artifacts service failed')
        else res.destroy()
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.startError = (error as Error).message
      this.deps.log('error', `The artifacts service cannot listen: ${this.startError}`)
      return
    }
    this.startError = null
    server.on('error', (error) => {
      this.deps.log('error', `The artifacts service: ${error.message}`)
    })
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy())
      this.upgrade(req, socket, head)
    })
    // The host's own channel keeps its process alive; the service alone must not.
    server.unref()
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  /** Stops listening; every token ends with it. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    this.grants.clear()
    this.sessions.clear()
    this.folders.clear()
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  get url(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}${SERVICE_PATH}`
  }

  /** The port it listens on, so main can refuse a page's requests to it. */
  get listeningPort(): number | null {
    return this.port
  }

  /** Why it does not listen, from its last try; null while it does. */
  get error(): string | null {
    return this.startError
  }

  /** Whether Kettu's memory is on, which lists its tools and their instructions. */
  private get memoryOn(): boolean {
    return this.memoryTools !== null && this.deps.memory?.service.enabled === true
  }

  /** Whether the host's Kettu account is signed in with Kettu's services on, for the Marketplace. */
  private get marketOn(): boolean {
    return this.deps.market?.on === true
  }

  /** The features that are on, which decide what agents are told and which skills they get. */
  get guideFlags(): GuideFlags {
    return {
      computer: this.deps.computer !== undefined,
      market: this.marketOn,
      suggest: this.workflowTools?.suggests ?? false,
      memory: this.memoryOn,
      passwords: this.deps.terminals?.passwords?.() === true,
    }
  }

  /**
   * The paragraph that goes into an agent's own instructions, or ahead of its first prompt: where
   * Kettu's tools are, and the skills or the guide's topics that say when to use them.
   */
  guidePrompt(skills: boolean, gateway = false, suggests = false): string {
    const text = guidePrompt(this.guideFlags, skills, gateway)
    // Another ACP agent reads the plan's rules in set_plan's description, which this one may drop.
    const plan = gateway ? `${text}\n\n${PLAN_PROMPT}` : text
    return suggests && this.suggestTools ? `${plan}\n\n${SUGGEST_PROMPT}` : plan
  }

  /** The prompt an agent that reads the servers' prompts puts into its instructions. */
  private prompt(gateway: boolean, suggests: boolean): string {
    const text = `${guidePrompt(this.guideFlags, true, gateway)}\n\n${PLAN_PROMPT}`
    return suggests && this.suggestTools ? `${text}\n\n${SUGGEST_PROMPT}` : text
  }

  /** What `tools/list` answers now: for an agent that drops tools, the core and the gateway. */
  private listedTools(grant?: Grant): Tool[] {
    const tools = this.allTools(grant)
    return grant?.gateway ? gatewayList(tools, grant.gated.size > 0) : tools
  }

  /** Every tool the session may use now; a step's session alone gets the step's tools. */
  private allTools(grant?: Grant): Tool[] {
    const sessionId = grant && 'sessionId' in grant ? grant.sessionId : null
    // Without a session, as for the Marketplace's page, every tool some agent gets.
    const skills = grant
      ? sessionId !== null && this.skillTools?.listed(sessionId)
      : this.skillTools
    return [
      guideTool(this.guideFlags),
      ...(skills ? SKILL_TOOLS : []),
      ...(this.terminalTools?.listed(this.serviceTools) ?? this.serviceTools),
      // Without a session, as for the Marketplace's page, while some agent may get it.
      ...(this.suggestTools && (grant ? grant.suggests : true) ? SUGGEST_TOOLS : []),
      ...(this.memoryOn ? MEMORY_TOOLS : []),
      ...(this.marketOn ? MARKET_TOOLS : []),
      ...(this.workflowTools?.listed(sessionId) ?? []),
      ...(this.deps.settings ? SETTINGS_TOOLS : []),
      ...(this.deps.routines ? ROUTINE_TOOLS : []),
      ...(this.deps.mcp ? MCP_TOOLS : []),
      ...(this.deps.plugins?.listed(sessionId) ?? []),
    ]
  }

  /** Each tool's name, the first sentence of its description and its group, for the Marketplace. */
  toolSummaries(): McpToolSummary[] {
    return this.listedTools().map((tool) => ({
      name: tool.name,
      description: firstSentence(tool.description ?? ''),
      group: this.deps.plugins?.has(tool.name)
        ? 'plugins'
        : (TOOL_GROUPS.get(tool.name) ?? 'sessions'),
      asks: ASKING_TOOLS.has(tool.name),
    }))
  }

  /**
   * What an attach of the session passes in `mcpServers`: the service with the session's token,
   * made at its first attach and kept while it stays in memory, since Codex ignores new servers
   * when it resumes a session it still holds open. Empty while the service is not running.
   * `gateway` lists only the core tools and the gateway to the rest, for an agent that drops tools;
   * `suggests` the next-message tool, for an agent that suggests by it.
   */
  servers(sessionId: string, project: string, gateway = false, suggests = false): McpServer[] {
    const url = this.url
    if (!url) return []
    const grant = this.sessionGrant(sessionId, project, true)
    grant.gateway = gateway
    grant.suggests = suggests
    return entry(url, grant.token, this.prompt(gateway, suggests))
  }

  /**
   * How an attach of the session reaches the library's servers: the same token as for the service
   * itself, from `process` and its folder for an agent that keeps one server of a name per folder.
   * A token made here alone reaches only the servers it is handed. An attach hands a session its
   * whole set, so it replaces the set before; a folder's token reaches what any of its sessions
   * was handed. Null while the service is not running.
   */
  routerAccess(
    sessionId: string,
    project: string,
    process: AgentProcess | null,
  ): {
    origin: string
    token: string
    allow(serverIds: readonly string[]): void
    gate(serverIds: readonly string[]): void
  } | null {
    if (this.port === null) return null
    const grant = process
      ? this.folderGrant(process, project, sessionId, false)
      : this.sessionGrant(sessionId, project, false)
    if (!process) {
      grant.servers = new Set()
      grant.gated = new Set()
    }
    return {
      origin: `http://127.0.0.1:${this.port}`,
      token: grant.token,
      allow: (serverIds) => {
        for (const id of serverIds) grant.servers.add(id)
      },
      gate: (serverIds) => {
        for (const id of serverIds) {
          grant.servers.add(id)
          grant.gated.add(id)
        }
      },
    }
  }

  private sessionGrant(sessionId: string, project: string, own: boolean): SessionGrant {
    const held = this.sessions.get(sessionId)
    let grant = held === undefined ? undefined : this.grants.get(held)
    if (!grant || !('sessionId' in grant) || grant.project !== project) {
      this.revoke(sessionId)
      grant = {
        token: newToken(),
        sessionId,
        project,
        own,
        gateway: false,
        suggests: false,
        servers: new Set(),
        gated: new Set(),
      }
      this.sessions.set(sessionId, this.add(grant))
    }
    if (own) grant.own = true
    return grant
  }

  /**
   * The same for an agent that keeps one server of a name per folder and names the session on
   * each call: one token for the process and folder, kept while a session there stays in memory
   * and the process runs, since each attach there replaces the folder's server for every session.
   */
  folderServers(
    process: AgentProcess,
    folder: string,
    sessionId: string,
    gateway = false,
    suggests = false,
  ): McpServer[] {
    const url = this.url
    if (!url) return []
    const grant = this.folderGrant(process, folder, sessionId, true)
    grant.gateway = gateway
    grant.suggests = suggests
    return entry(url, grant.token, this.prompt(gateway, suggests))
  }

  private folderGrant(
    process: AgentProcess,
    folder: string,
    sessionId: string,
    own: boolean,
  ): FolderGrant {
    let byFolder = this.folders.get(process)
    if (!byFolder) {
      byFolder = new Map()
      this.folders.set(process, byFolder)
      const exited = (): void => this.exited(process)
      void process.closed.then(exited, exited)
    }
    let key = byFolder.get(folder)
    let grant = key === undefined ? undefined : this.grants.get(key)
    if (key === undefined || !grant || 'sessionId' in grant) {
      grant = {
        token: newToken(),
        project: folder,
        process,
        sessions: new Set(),
        own,
        gateway: false,
        suggests: false,
        servers: new Set(),
        gated: new Set(),
      }
      key = this.add(grant)
      byFolder.set(folder, key)
    }
    if (this.sessions.get(sessionId) !== key) {
      this.leave(sessionId)
      grant.sessions.add(sessionId)
      this.sessions.set(sessionId, key)
    }
    if (own) grant.own = true
    return grant
  }

  /** The session left memory: it closed, was released or was deleted. */
  revoke(sessionId: string): void {
    this.tools.forget(sessionId)
    this.dataTools?.forget(sessionId)
    this.planTools.forget(sessionId)
    this.leave(sessionId)
  }

  private add(grant: Grant): string {
    const key = digest(grant.token)
    this.grants.set(key, grant)
    return key
  }

  /** Its own token ends; a folder's ends with the last session there. */
  private leave(sessionId: string): void {
    const key = this.sessions.get(sessionId)
    if (key === undefined) return
    this.sessions.delete(sessionId)
    const grant = this.grants.get(key)
    if (!grant) return
    if ('sessionId' in grant) {
      this.grants.delete(key)
      this.deps.router?.forget(key)
      return
    }
    grant.sessions.delete(sessionId)
    if (grant.sessions.size > 0) return
    this.grants.delete(key)
    this.deps.router?.forget(key)
    const byFolder = this.folders.get(grant.process)
    if (byFolder?.get(grant.project) === key) byFolder.delete(grant.project)
  }

  /** The process exited: its folder tokens end, and its sessions get new ones as they attach. */
  private exited(process: AgentProcess): void {
    const byFolder = this.folders.get(process)
    if (!byFolder) return
    this.folders.delete(process)
    for (const key of byFolder.values()) {
      const grant = this.grants.get(key)
      this.grants.delete(key)
      this.deps.router?.forget(key)
      if (!grant || 'sessionId' in grant) continue
      for (const sessionId of grant.sessions) {
        if (this.sessions.get(sessionId) === key) this.sessions.delete(sessionId)
      }
    }
  }

  /** Who a call is from: the token's session, or the session a folder token's call names. */
  private callerOf(grant: Grant, meta: Record<string, unknown> | undefined): Caller | null {
    if ('sessionId' in grant)
      return this.withFolder({ sessionId: grant.sessionId, project: grant.project })
    const id = meta?.[SESSION_META]
    const sessionId = typeof id === 'string' ? this.deps.sessionOf(grant.process, id) : null
    if (sessionId === null || !grant.sessions.has(sessionId)) return null
    const subagent = typeof id === 'string' && this.deps.subagentCall?.(grant.process, id) === true
    return this.withFolder({ sessionId, project: grant.project, ...(subagent ? { subagent } : {}) })
  }

  /** A caller in a worktree reads its sources there, while its artifacts stay its project's. */
  private withFolder(caller: Caller): Caller {
    const folder = this.deps.sessionFolder?.(caller.sessionId)
    return folder && folder !== caller.project ? { ...caller, folder } : caller
  }

  private grantOf(header: string | undefined): Grant | null {
    const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header ?? '')
    if (!match) return null
    const token = match[1]!
    const grant = this.grants.get(digest(token))
    if (!grant) return null
    const given = Buffer.from(token)
    const known = Buffer.from(grant.token)
    return given.length === known.length && timingSafeEqual(given, known) ? grant : null
  }

  /** Who a router request is from, by its token; null for a token Kettu does not have. */
  private routerCaller(header: string | undefined): RouterCaller | null {
    const grant = this.grantOf(header)
    return grant ? this.routerCallerOf(grant) : null
  }

  private routerCallerOf(grant: Grant): RouterCaller {
    const sessionId = 'sessionId' in grant ? grant.sessionId : null
    return {
      key: digest(grant.token),
      sessionId,
      folder: (sessionId && this.deps.sessionFolder?.(sessionId)) || grant.project,
      servers: grant.servers,
      ...('sessions' in grant ? { sessions: grant.sessions } : {}),
    }
  }

  /**
   * The bridge's connection to a server, checked as every request is before it becomes a stream:
   * no page's `Origin`, this host's `Host`, a token Kettu gave out.
   */
  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const deny = (status: number, message: string): void => {
      const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden'
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\n` +
          `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
      )
    }
    if (req.headers.origin !== undefined) return deny(403, 'Requests from web pages are refused')
    if (req.headers.host !== `127.0.0.1:${this.port}`) return deny(403, 'Unknown host')
    const path = (req.url ?? '').split('?')[0]!
    const router = this.deps.router
    if (!router || !path.startsWith(BRIDGE_PREFIX)) return deny(404, 'Not found')
    if (req.headers.upgrade?.toLowerCase() !== BRIDGE_UPGRADE) return deny(404, 'Not found')
    const caller = this.routerCaller(req.headers.authorization)
    if (!caller) return deny(401, 'Kettu does not know this token; reconnect the server')
    let name: string
    try {
      name = decodeURIComponent(path.slice(BRIDGE_PREFIX.length))
    } catch {
      return deny(404, 'Not found')
    }
    router.upgrade(socket, head, caller, name)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A browser sends Origin on every cross-origin request; no agent's MCP client does.
    if (req.headers.origin !== undefined) {
      return refuse(res, 403, 'Requests from web pages are refused')
    }
    // A name that resolves here by DNS rebinding still carries its own Host.
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      return refuse(res, 403, 'Unknown host')
    }
    const path = (req.url ?? '').split('?')[0]!
    if (McpRouter.owns(path) && this.deps.router) {
      const caller = this.routerCaller(req.headers.authorization)
      if (!caller) {
        return refuse(res, 401, 'A session token is required', { 'WWW-Authenticate': 'Bearer' })
      }
      return this.deps.router.handle(req, res, caller, path)
    }
    if (req.url !== SERVICE_PATH) return refuse(res, 404, 'Not found')
    if (req.method !== 'POST') {
      // Plain JSON only: no event stream to open, and no session to end.
      return refuse(res, 405, 'Method not allowed', { Allow: 'POST' })
    }
    const grant = this.grantOf(req.headers.authorization)
    if (!grant) {
      return refuse(res, 401, 'A session token is required', { 'WWW-Authenticate': 'Bearer' })
    }
    if (!grant.own) return refuse(res, 403, "Kettu's own server is off for this agent")
    // A failed load is tried again with the next request rather than kept.
    this.sdk ??= loadSdk().catch((error: unknown) => {
      this.sdk = null
      throw error
    })
    const sdk = await this.sdk
    const server = this.mcpServer(sdk, grant)
    const transport = new sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: BODY_BYTES,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  /** Hands the calling session's thread what a call wrote; a failure only costs the thread its entry. */
  private async record(
    sessionId: string,
    tool: string,
    input: unknown,
    result: CallToolResult,
  ): Promise<void> {
    const { wrote, store } = this.deps
    if (!wrote) return
    const titleOf = (id: string) =>
      store.get(id).then(
        (found) => found.artifact.title,
        () => null,
      )
    try {
      const write = await artifactWrite(tool, input, result, titleOf)
      if (write) wrote(sessionId, write)
    } catch (error) {
      this.deps.log('warn', `Could not add ${tool} to the thread: ${(error as Error).message}`)
    }
  }

  /** A server for one request with the token, as a stateless transport needs. */
  private mcpServer(sdk: Sdk, grant: Grant): Server {
    const { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } = sdk
    const flags = this.guideFlags
    const instructions = serviceInstructions(flags)
    const server = new sdk.Server(
      { name: SERVICE_NAME, title: 'Kettu', version: this.deps.appVersion },
      { capabilities: { tools: {} }, instructions },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.listedTools(grant),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: input, _meta: meta } = request.params
      const caller = this.callerOf(grant, meta)
      if (!caller) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'The call names no session of this agent in this folder',
        )
      }
      if (name === GATEWAY_TOOL && grant.gateway) {
        return this.callGateway(sdk, grant, caller, input, flags)
      }
      if (name === FIND_TOOL && grant.gateway && grant.gated.size > 0) {
        const query = (input as { query?: unknown } | undefined)?.query
        return findTools(query, [
          ...this.allTools(grant).map((tool) => ({ server: null, tool })),
          ...(await this.gatedTools(grant)),
        ])
      }
      return this.callTool(sdk, grant, caller, name, input, flags)
    })
    return server
  }

  /**
   * A call through the gateway: the tool's description and arguments without `arguments`, else the
   * tool's own call as if it had been called directly, a failed one with its arguments added.
   */
  private async callGateway(
    sdk: Sdk,
    grant: Grant,
    caller: Caller,
    input: unknown,
    flags: GuideFlags,
  ): Promise<CallToolResult> {
    const call = gatewayInput(input)
    if ('error' in call) {
      return { content: [{ type: 'text', text: call.error }], isError: true }
    }
    if (call.server !== undefined) return this.callGated(grant, call)
    const tools = this.allTools(grant)
    const tool = tools.find((listed) => listed.name === call.tool)
    if (!tool) return unknownTool(call.tool, tools)
    if (call.arguments === undefined) return described(tool)
    try {
      const result = await this.callTool(sdk, grant, caller, tool.name, call.arguments, flags)
      if (!result.isError) return result
      // A plugin's tool that took its arguments and then failed has nothing in them to correct.
      if (
        isPluginToolName(tool.name) &&
        !this.deps.plugins?.argumentsWrong(tool.name, call.arguments)
      ) {
        return result
      }
      return withArguments(result, tool)
    } catch (error) {
      const text = (error as Error).message
      return withArguments({ content: [{ type: 'text', text }], isError: true }, tool)
    }
  }

  /** The servers behind the gateway for this grant, by name. */
  private gatedServers(grant: Grant): MarketServer[] {
    return [...grant.gated].flatMap((id) => this.deps.libraryServer?.(id) ?? [])
  }

  /** The tools of the servers behind the gateway; a server that cannot list is left out. */
  private async gatedTools(grant: Grant): Promise<Findable[]> {
    const router = this.deps.router
    if (!router) return []
    const caller = this.routerCallerOf(grant)
    const lists = await Promise.all(
      this.gatedServers(grant).map(async (server) => {
        try {
          const tools = await router.tools(server, caller)
          return tools.map((tool) => ({ server: server.name, tool }))
        } catch (error) {
          this.deps.log(
            'warn',
            `Could not list ${server.name}'s tools: ${(error as Error).message}`,
          )
          return []
        }
      }),
    )
    return lists.flat()
  }

  /** A gateway call to a tool of a server behind it, described when it has no arguments. */
  private async callGated(
    grant: Grant,
    call: { tool: string; server?: string; arguments?: Record<string, unknown> },
  ): Promise<CallToolResult> {
    const router = this.deps.router
    const server = this.gatedServers(grant).find((item) => item.name === call.server)
    const fail = (text: string): CallToolResult => ({
      content: [{ type: 'text', text }],
      isError: true,
    })
    if (!router || !server) {
      const names = this.gatedServers(grant).map((item) => item.name)
      return fail(
        `${call.server} is not an MCP server behind ${GATEWAY_TOOL}. Its servers: ${names.join(', ')}.`,
      )
    }
    const caller = this.routerCallerOf(grant)
    let tools: Tool[]
    try {
      tools = await router.tools(server, caller)
    } catch (error) {
      return fail(`${server.name} could not list its tools: ${(error as Error).message}`)
    }
    const tool = tools.find((item) => item.name === call.tool)
    if (!tool) {
      return fail(
        `${server.name} has no tool ${call.tool}. Its tools: ${tools.map((item) => item.name).join(', ')}.`,
      )
    }
    if (call.arguments === undefined) return described(tool, server.name)
    try {
      const result = await router.call(server, caller, tool.name, call.arguments)
      return result.isError ? withArguments(result, tool) : result
    } catch (error) {
      return withArguments(fail((error as Error).message), tool)
    }
  }

  /** A guide topic; for an agent behind the gateway, with the topic's tools it calls by it. */
  private guideCall(grant: Grant, input: unknown, flags: GuideFlags): CallToolResult {
    const result = callGuide(input, flags)
    const topic = result.structuredContent?.topic as GuideTopic | undefined
    const group = topic === undefined ? undefined : TOPIC_GROUPS[topic]
    if (!grant.gateway || result.isError || group === undefined) return result
    const extra = topicTools(
      this.allTools(grant).filter(
        (tool) => tool.name !== GUIDE_TOOL && TOOL_GROUPS.get(tool.name) === group,
      ),
    )
    if (!extra) return result
    const text = `${result.structuredContent!.text as string}${extra}`
    return { content: [{ type: 'text', text }], structuredContent: { topic, text } }
  }

  /** Runs one of Kettu's tools for the caller. */
  private async callTool(
    sdk: Sdk,
    grant: Grant,
    caller: Caller,
    name: string,
    input: unknown,
    flags: GuideFlags,
  ): Promise<CallToolResult> {
    const { ErrorCode, McpError } = sdk
    if (name === GUIDE_TOOL) return this.guideCall(grant, input, flags)
    if (this.skillTools && isSkillToolName(name)) return this.skillTools.call(caller, name, input)
    if (isSessionToolName(name)) {
      try {
        return await this.sessionTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    if (this.workflowTools && isWorkflowToolName(name)) {
      try {
        return await this.workflowTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    if (isPlanToolName(name)) {
      try {
        return this.planTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${PLAN_TOOL} failed: ${(error as Error).message}`)
        throw new McpError(
          ErrorCode.InternalError,
          `${PLAN_TOOL} failed: ${(error as Error).message}`,
        )
      }
    }
    if (this.suggestTools && isSuggestToolName(name)) {
      return this.suggestTools.call(caller, name, input)
    }
    if (isReportToolName(name)) {
      try {
        return this.reportTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${REPORT_TOOL} failed: ${(error as Error).message}`)
        throw new McpError(
          ErrorCode.InternalError,
          `${REPORT_TOOL} failed: ${(error as Error).message}`,
        )
      }
    }
    if (this.memoryTools && isMemoryToolName(name)) {
      // While memory is off they are not listed, and a call answers that it is off.
      try {
        return await this.memoryTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    const market = this.deps.market
    if (market && isMarketToolName(name)) {
      // While signed out they are not listed, and a call answers why.
      try {
        return await market.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    const settings = this.deps.settings
    if (settings && isSettingsToolName(name)) {
      try {
        return await settings.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    const routines = this.deps.routines
    if (routines && isRoutineToolName(name)) {
      try {
        return await routines.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    const mcp = this.deps.mcp
    if (mcp && isMcpToolName(name)) {
      try {
        return await mcp.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    // A plugin that was turned off since the agent listed its tools answers that it is off.
    if (this.deps.plugins && isPluginToolName(name)) {
      return this.deps.plugins.call(name, input, caller.sessionId)
    }
    if (isBrowserToolName(name)) {
      try {
        return await this.browserTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    if (isDeviceToolName(name)) {
      if (!this.deviceTools) {
        throw new McpError(ErrorCode.InternalError, `${name} is not available on this host`)
      }
      try {
        return await this.deviceTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    if (isTerminalToolName(name)) {
      if (!this.terminalTools) {
        throw new McpError(ErrorCode.InternalError, `${name} is not available on this host`)
      }
      try {
        return await this.terminalTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    const computer = this.deps.computer
    if (computer && isComputerToolName(name)) {
      // A subagent uses the computer as the session it runs under.
      const sessionId = this.deps.browserSession?.(caller.sessionId) ?? caller.sessionId
      return computer.call(sessionId, name, input)
    }
    if (isDataToolName(name)) {
      if (!this.dataTools) {
        throw new McpError(ErrorCode.InternalError, `${name} is not available on this host`)
      }
      try {
        return await this.dataTools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    }
    if (!isToolName(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}`)
    try {
      const result = await this.tools.call(caller, name, input)
      // Before the answer, while the agent still shows its tool call as running.
      await this.record(caller.sessionId, name, input, result)
      return result
    } catch (error) {
      this.deps.log('error', `${name} failed: ${(error as Error).message}`)
      throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
    }
  }
}
