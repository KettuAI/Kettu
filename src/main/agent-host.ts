import type { DeviceCall, DeviceCallAnswer } from '@shared/device-agent'
import { join } from 'node:path'
import { app, MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import {
  errorAnswer,
  isLastAnswer,
  isRuntimeAnswer,
  messageHeader,
  type RuntimeAnswer,
} from '@shared/artifact-capabilities'
import { artifactPathProblem, VERSION_FILES } from '@shared/artifact-files'
import {
  ARTIFACT_ID,
  type ArtifactImportFailure,
  type ArtifactImportResult,
} from '@shared/artifacts'
import type { AttachmentGrant } from '@shared/attachments'
import {
  isOriginDecision,
  type BrowserCallAnswer,
  type BrowserCallRequest,
  type BrowserOriginAnswer,
  type BrowserOriginDecision,
} from '@shared/browser'
import {
  type ArtifactExportFormat,
  type ExportedFile,
  isArtifactTypeName,
} from '@shared/artifact-types'
import type {
  ArtifactBrief,
  ArtifactContentResult,
  ArtifactExportResult,
  BusyCounts,
  BusySession,
  HostToMain,
  MainToHost,
} from '@shared/host-control'
import { isComputerApp, type ComputerApp } from '@shared/computer-use'
import { isMediaType, MEDIA_TOKEN, type MediaGrantRecord } from '@shared/media'
import type { PortDevice } from '@shared/remote/device'
import { reportBuildResult, type ReportBuildResult } from '@shared/report'
import type { HostSettings } from '@shared/settings'
import agentHostPath from '../agent-host/index?modulePath'
// The host's own bundle is built without electron-vite's worker plugin, so main builds this one.
import sessionRouterPath from '../agent-host/session-router/router?modulePath'
import threadWorkerPath from '../agent-host/threads/worker?modulePath'
import usageWorkerPath from '../agent-host/usage/worker?modulePath'
import { processControl, stopTrees, type ProcessId } from '../agent-host/process-tree'
import { ContentCache } from './artifacts/content-cache'
import { computerHostOptions } from './computer-use'
import { GrantRequests } from './grant-requests'
import type { MarketKeysPush } from './market-keys'
import { t } from './i18n'
import { createLogger } from './log'
import { UtilityHost, type UtilityHostEvent, type UtilityHostState } from './utility-host'

const log = createLogger('agent-host')

export interface AgentHostDeps {
  settings(): HostSettings
  /** The Marketplace's key store, values and OAuth sign-ins, which follows init at each start. */
  marketKeys(): MarketKeysPush
  /** The host asks to keep or clear a server's OAuth sign-in; main checks it against the settings. */
  onMarketOAuth?(serverId: unknown, state: unknown): void
  /** The host's first start found the programs of these harnesses; main adds their agents. */
  onFirstStart?(harnesses: unknown): void
  onAttention(message: Extract<HostToMain, { type: 'host:attention' }>): void
  /** What waits for the user by session, and a session seen, for the devices' notifications. */
  onWaiting?(sessions: Record<string, string[]>): void
  onSeen?(sessionId: string): void
  onBadge(count: number): void
  onBusy(counts: BusyCounts): void
  onProjects(paths: string[]): void
  /** An artifact was made, changed, deleted or restored. */
  onArtifactsChanged?(): void
  onSessionsEnded(sessionIds: string[]): void
  onAuthCommands(commands: string[]): void
  /** A file the host granted, for the media scheme to serve. */
  onMediaGrant(grant: MediaGrantRecord): void
  /** A session's grants are gone, or every grant for null, as when the host stopped. */
  onMediaRevoke(sessionId: string | null): void
  /** Whether any routine run is starting or running, for keeping the computer awake. */
  onRoutinesWorking(working: boolean): void
  /** The host started and answers requests, at launch and after each restart. */
  onReady?(): void
  /** The host stopped or crashed; it may start again, and `onReady` says when. */
  onDown?(): void
  /** The artifacts service's port, which the browser's pages must never reach. */
  onServicePort?(port: number | null): void
  /**
   * A browser tool call for main to run on the session's page. Set after construction, since the
   * pages need the host to send their state.
   */
  browser?: (request: BrowserCallRequest) => Promise<BrowserCallAnswer>
  /** An agent's device tool call, run by the device host. Set after construction, like `browser`. */
  device?: (call: DeviceCall) => Promise<DeviceCallAnswer>
  /** A window's or device's answer to the new origin a page of main's asked for. */
  onOriginDecided?(sessionId: string, requestId: number, decision: BrowserOriginDecision): void
  /** A session's card allowed an app always, for the settings to keep. */
  onComputerAppAllowed?(app: ComputerApp): void
}

const MAX_LIST = 10_000
const MAX_STRING = 8192
/** How long an agent's tree gets between SIGTERM and SIGKILL after its host died. */
const GRACE_MS = 2_000
/** How long the host gets to take a grant before the attachment counts as not added. */
const GRANT_TIMEOUT_MS = 5_000
/** How long the protocol waits for the host to name a version's files. */
const CONTENT_TIMEOUT_MS = 10_000
/** How long an import waits for the host to make the artifact. */
const IMPORT_TIMEOUT_MS = 10_000
/** How long main waits for the host to list its artifacts. */
const LIST_TIMEOUT_MS = 10_000
/** How long an export may take the host, which converts a whole version. */
const EXPORT_TIMEOUT_MS = 120_000
// Reading two days of logs and packing them can take a while on a busy computer.
const REPORT_TIMEOUT_MS = 120_000
const MAX_FORMAT = 1_000
const MAX_ARTIFACTS = 1_000_000

type ImportAnswer = NonNullable<ArtifactImportResult>
const IMPORT_FAILURES: ReadonlySet<string> = new Set<ArtifactImportFailure>([
  'too_large',
  'too_many',
  'no_index',
  'bad_name',
  'not_utf8',
  'unreadable',
  'unavailable',
])
const UNAVAILABLE: ImportAnswer = { failed: 'unavailable' }

/** The copy beside app.asar that a packaged build unpacks a file into; the path itself in dev. */
function unpackedPath(file: string): string {
  if (!app.isPackaged) return file
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING)
  )
}

function isContentFile(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { path, file, size } = value as Record<string, unknown>
  return (
    typeof path === 'string' &&
    artifactPathProblem(path) === null &&
    typeof file === 'string' &&
    file.length <= MAX_STRING &&
    isCount(size)
  )
}

function isContentResult(value: unknown): value is ArtifactContentResult {
  if (typeof value !== 'object' || value === null) return false
  const { kind, files, version, title, key, strict } = value as Record<string, unknown>
  if (kind === 'not_found' || kind === 'failed') return true
  return (
    kind === 'found' &&
    typeof strict === 'boolean' &&
    Array.isArray(files) &&
    files.length <= VERSION_FILES &&
    files.every(isContentFile) &&
    Number.isSafeInteger(version) &&
    (version as number) >= 1 &&
    typeof title === 'string' &&
    typeof key === 'string' &&
    /^[0-9a-f]{64}$/.test(key) &&
    isTypeInfo((value as Record<string, unknown>).type)
  )
}

/** A version's type as the host names it: absent or null for a plain artifact. */
function isTypeInfo(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object') return false
  const { name, format } = value as Record<string, unknown>
  return (
    isArtifactTypeName(name) &&
    Number.isSafeInteger(format) &&
    (format as number) >= 1 &&
    (format as number) <= MAX_FORMAT
  )
}

function isExportedFile(value: unknown): value is ExportedFile {
  if (typeof value !== 'object' || value === null) return false
  const { path, bytes } = value as Record<string, unknown>
  return (
    typeof path === 'string' && artifactPathProblem(path) === null && bytes instanceof Uint8Array
  )
}

function isExportResult(value: unknown): value is ArtifactExportResult {
  if (typeof value !== 'object' || value === null) return false
  const { kind, title, files, message } = value as Record<string, unknown>
  if (kind === 'not_found') return true
  if (kind === 'failed') return typeof message === 'string'
  return (
    kind === 'exported' &&
    typeof title === 'string' &&
    Array.isArray(files) &&
    files.length >= 1 &&
    files.length <= VERSION_FILES &&
    files.every(isExportedFile)
  )
}

const FAILED_EXPORT: ArtifactExportResult = { kind: 'failed', message: 'The agent host is down' }

function isBrief(value: unknown): value is ArtifactBrief {
  if (typeof value !== 'object' || value === null) return false
  const { id, version, createdAt, updatedAt, deleted } = value as Record<string, unknown>
  return (
    typeof id === 'string' &&
    ARTIFACT_ID.test(id) &&
    Number.isSafeInteger(version) &&
    (version as number) >= 1 &&
    Number.isFinite(createdAt) &&
    Number.isFinite(updatedAt) &&
    typeof deleted === 'boolean'
  )
}

/** The listed artifacts, or null for a failed or malformed answer. */
function listedArtifacts(value: unknown): ArtifactBrief[] | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, artifacts } = value as Record<string, unknown>
  if (kind !== 'listed' || !Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) {
    return null
  }
  return artifacts.every(isBrief) ? (artifacts as ArtifactBrief[]) : null
}

function isImportAnswer(value: unknown): value is ImportAnswer {
  if (typeof value !== 'object' || value === null) return false
  const { id, failed } = value as Record<string, unknown>
  if (typeof id === 'string') return ARTIFACT_ID.test(id)
  return typeof failed === 'string' && IMPORT_FAILURES.has(failed)
}

function isMediaGrant(value: unknown): value is MediaGrantRecord {
  if (typeof value !== 'object' || value === null) return false
  const { token, path, mimeType, sessionId } = value as Record<string, unknown>
  return (
    typeof token === 'string' &&
    MEDIA_TOKEN.test(token) &&
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= MAX_STRING &&
    isMediaType(mimeType) &&
    (sessionId === null || (typeof sessionId === 'string' && sessionId.length <= MAX_STRING))
  )
}

function isBusySession(value: unknown): value is BusySession {
  if (typeof value !== 'object' || value === null) return false
  const { sessionId, agentId, title, turnStartedAt } = value as Record<string, unknown>
  return (
    typeof sessionId === 'string' &&
    typeof agentId === 'string' &&
    (title === null || typeof title === 'string') &&
    (turnStartedAt === null || Number.isFinite(turnStartedAt))
  )
}

/** Main's side of the agent host: supervision, ports, and what the host asks main to do. */
export class AgentHost {
  private readonly host: UtilityHost<MainToHost, HostToMain>
  private agentProcesses: ProcessId[] = []
  private readonly busyRequests = new Map<number, (sessions: BusySession[]) => void>()
  private nextBusyId = 1
  private readonly reportRequests = new Map<number, (result: ReportBuildResult) => void>()
  private nextReportId = 1
  private readonly grants = new GrantRequests(
    GRANT_TIMEOUT_MS,
    () => new Error(t('attachments.hostDown')),
  )
  private readonly contentRequests = new Map<number, (result: ArtifactContentResult) => void>()
  private nextContentId = 1
  private readonly contents = new ContentCache((id, version) => this.askContent(id, version))
  private readonly importRequests = new Map<number, (result: ImportAnswer) => void>()
  private nextImportId = 1
  private readonly exportRequests = new Map<number, (result: ArtifactExportResult) => void>()
  private nextExportId = 1
  private readonly listRequests = new Map<number, (list: ArtifactBrief[] | null) => void>()
  private nextListId = 1
  private readonly runtimeRequests = new Map<number, (answer: RuntimeAnswer) => void>()
  private nextRuntimeId = 1

  constructor(private readonly deps: AgentHostDeps) {
    this.host = new UtilityHost<MainToHost, HostToMain>({
      label: 'agent-host',
      channel: 'agent-host',
      modulePath: agentHostPath,
      serviceName: 'Kettu Agent Host',
      initMessage: () => ({
        type: 'host:init',
        userDataPath: app.getPath('userData'),
        appVersion: app.getVersion(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        nodeRuntime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
        fakeAgentPath: app.isPackaged
          ? (process.env.KETTU_FAKE_AGENT ?? null)
          : join(app.getAppPath(), 'tools/fake-agent/main.ts'),
        threadWorkerPath,
        usageWorkerPath,
        // The router runs on the user's Node.js, which cannot read inside app.asar.
        sessionRouterPath: unpackedPath(sessionRouterPath),
        settings: deps.settings(),
        computer: computerHostOptions(),
      }),
      startMessages: () => [{ type: 'host:market-keys', ...deps.marketKeys() }],
      connectMessage: (windowId) => ({ type: 'host:connect', windowId }),
      shutdownMessage: { type: 'host:shutdown' },
      readyType: 'host:ready',
      stoppedType: 'host:stopped',
      onMessage: (message) => this.receive(message),
      onReady: () => this.deps.onReady?.(),
      onExit: (clean) => this.exited(clean),
    })
  }

  get state(): UtilityHostState {
    return this.host.state
  }

  history(): UtilityHostEvent[] {
    return this.host.history()
  }

  start(): void {
    this.host.start()
  }

  connect(webContents: WebContents): void {
    this.host.connect(webContents)
  }

  revoke(webContents: WebContents): void {
    this.host.revoke(webContents)
  }

  /**
   * A port for a paired device's session, which the host serves with what devices may do; null
   * while the host is not running.
   */
  connectDevice(device: PortDevice): MessagePortMain | null {
    if (this.host.state !== 'ready') return null
    const { port1, port2 } = new MessageChannelMain()
    if (this.host.post({ type: 'host:connect', device }, [port1])) return port2
    port1.close()
    port2.close()
    return null
  }

  restart(): void {
    this.host.restart()
  }

  pushSettings(settings: HostSettings): void {
    this.host.post({ type: 'host:settings', settings })
  }

  /** The Marketplace's key store, whole; a host started later gets it too. */
  pushMarketKeys(contents: MarketKeysPush): void {
    this.host.post({ type: 'host:market-keys', ...contents })
  }

  /** Allow once from a request's notification, which the host answers as its own window would. */
  answerPermission(sessionId: string, requestId: string, optionId: string): void {
    this.host.post({ type: 'host:permission-answer', sessionId, requestId, optionId })
  }

  /** The computer slept or woke, for the routines' schedule timer. */
  power(state: 'suspend' | 'resume'): void {
    this.host.post({ type: 'host:power', state })
  }

  /** The log level and detailed records; a host started later takes both from its environment. */
  setLogLevel(level: 'debug' | 'info', verbose: boolean): void {
    this.host.post({ type: 'host:log-level', level, verbose })
  }

  /** The sessions that are working, or none if the host does not answer within `timeoutMs`. */
  busy(timeoutMs: number): Promise<BusySession[]> {
    if (this.host.state !== 'ready') return Promise.resolve([])
    const requestId = this.nextBusyId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.busyRequests.delete(requestId)
        log.warn(`No busy answer within ${timeoutMs} ms`)
        resolve([])
      }, timeoutMs)
      this.busyRequests.set(requestId, (sessions) => {
        clearTimeout(timer)
        resolve(sessions)
      })
      if (!this.host.post({ type: 'host:busy-request', requestId })) {
        this.busyRequests.get(requestId)?.([])
        this.busyRequests.delete(requestId)
      }
    })
  }

  /** A problem report's bundle, which the host writes into its data folder. */
  report(
    params: Omit<Extract<MainToHost, { type: 'host:report-request' }>, 'type' | 'requestId'>,
  ): Promise<ReportBuildResult> {
    const down: ReportBuildResult = {
      ok: false,
      reason: 'failed',
      message: 'The agent host is down',
    }
    if (this.host.state !== 'ready') return Promise.resolve(down)
    const requestId = this.nextReportId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.reportRequests.delete(requestId)
        log.warn(`No report within ${REPORT_TIMEOUT_MS} ms`)
        resolve({ ok: false, reason: 'failed', message: 'The agent host did not answer in time' })
      }, REPORT_TIMEOUT_MS)
      this.reportRequests.set(requestId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      if (!this.host.post({ type: 'host:report-request', requestId, ...params })) {
        this.reportRequests.get(requestId)?.(down)
        this.reportRequests.delete(requestId)
      }
    })
  }

  /**
   * Hands the host the paths behind attachment grants and waits until it holds them, so the
   * renderer, which hears of a grant only after this, never asks for one the host lacks.
   */
  grant(grants: AttachmentGrant[]): Promise<void> {
    if (grants.length === 0) return Promise.resolve()
    if (this.host.state !== 'ready') return Promise.reject(new Error(t('attachments.hostDown')))
    return this.grants.request((requestId) =>
      this.host.post({ type: 'host:grant', requestId, grants }),
    )
  }

  /** The file of an artifact's version, the latest when `version` is null; `failed` without a host. */
  artifactContent(id: string, version: number | null): Promise<ArtifactContentResult> {
    if (this.host.state !== 'ready') return Promise.resolve({ kind: 'failed' })
    return this.contents.get(id, version)
  }

  private askContent(id: string, version: number | null): Promise<ArtifactContentResult> {
    const requestId = this.nextContentId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.contentRequests.delete(requestId)
        log.warn(`No artifact content answer within ${CONTENT_TIMEOUT_MS} ms`)
        resolve({ kind: 'failed' })
      }, CONTENT_TIMEOUT_MS)
      this.contentRequests.set(requestId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      if (!this.host.post({ type: 'host:artifact-content-request', requestId, id, version })) {
        this.contentRequests.get(requestId)?.({ kind: 'failed' })
        this.contentRequests.delete(requestId)
      }
    })
  }

  /** Every artifact the host has, Recently deleted included; null when it cannot say. */
  artifacts(): Promise<ArtifactBrief[] | null> {
    if (this.host.state !== 'ready') return Promise.resolve(null)
    const requestId = this.nextListId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listRequests.delete(requestId)
        log.warn(`No artifact list within ${LIST_TIMEOUT_MS} ms`)
        resolve(null)
      }, LIST_TIMEOUT_MS)
      this.listRequests.set(requestId, (ids) => {
        clearTimeout(timer)
        resolve(ids)
      })
      if (!this.host.post({ type: 'host:artifact-list-request', requestId })) {
        this.listRequests.get(requestId)?.(null)
        this.listRequests.delete(requestId)
      }
    })
  }

  /**
   * Passes a page's message to the host, whose answers go to `answer`: one, or a stream's events
   * and then its end. Returns the cancel, which ends a stream; a host that is gone answers
   * `failed`.
   */
  artifactRuntime(
    artifactId: string,
    message: unknown,
    answer: (answer: RuntimeAnswer) => void,
  ): () => void {
    const gone = (): void =>
      answer(errorAnswer(messageHeader(message), 'failed', 'Kettu cannot answer right now.'))
    if (this.host.state !== 'ready') {
      gone()
      return () => {}
    }
    const requestId = this.nextRuntimeId++
    this.runtimeRequests.set(requestId, (next) => {
      if (isLastAnswer(next)) this.runtimeRequests.delete(requestId)
      answer(next)
    })
    if (!this.host.post({ type: 'host:artifact-runtime', requestId, artifactId, message })) {
      this.runtimeRequests.delete(requestId)
      gone()
    }
    return () => {
      if (this.runtimeRequests.delete(requestId)) {
        this.host.post({ type: 'host:artifact-runtime-cancel', requestId })
      }
    }
  }

  /** `host:browser-waiting`: the call waits on a new origin, so its own limit covers that wait. */
  browserWaiting(callId: number, waiting: boolean): void {
    this.host.post({ type: 'host:browser-waiting', callId, waiting })
  }

  /** `host:browser-origin-ask`: the session's thread shows the page's new origin, waiting. */
  originAsked(request: { sessionId: string; id: number; origin: string }): void {
    this.host.post({
      type: 'host:browser-origin-ask',
      requestId: request.id,
      sessionId: request.sessionId,
      origin: request.origin,
    })
  }

  /**
   * `host:browser-origin-answer`: how the page's wait ended, from either place, so the session's
   * card takes it; a host that is gone has nothing to show it.
   */
  originAnswered(request: { id: number; decision: BrowserOriginAnswer }): void {
    this.host.post({
      type: 'host:browser-origin-answer',
      requestId: request.id,
      decision: request.decision,
    })
  }

  /** Has the host make an artifact of a file the user chose; `unavailable` without a host. */
  artifactImport(path: string, project: string | null): Promise<ImportAnswer> {
    if (this.host.state !== 'ready') return Promise.resolve(UNAVAILABLE)
    const requestId = this.nextImportId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.importRequests.delete(requestId)
        log.warn(`No artifact import answer within ${IMPORT_TIMEOUT_MS} ms`)
        resolve(UNAVAILABLE)
      }, IMPORT_TIMEOUT_MS)
      this.importRequests.set(requestId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      if (!this.host.post({ type: 'host:artifact-import-request', requestId, path, project })) {
        this.importRequests.get(requestId)?.(UNAVAILABLE)
        this.importRequests.delete(requestId)
      }
    })
  }

  /** A typed version converted by the host, for a save dialog's file; `failed` without a host. */
  artifactExport(
    id: string,
    version: number,
    format: ArtifactExportFormat,
  ): Promise<ArtifactExportResult> {
    if (this.host.state !== 'ready') return Promise.resolve(FAILED_EXPORT)
    const requestId = this.nextExportId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exportRequests.delete(requestId)
        log.warn(`No artifact export answer within ${EXPORT_TIMEOUT_MS} ms`)
        resolve(FAILED_EXPORT)
      }, EXPORT_TIMEOUT_MS)
      this.exportRequests.set(requestId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      if (
        !this.host.post({ type: 'host:artifact-export-request', requestId, id, version, format })
      ) {
        this.exportRequests.get(requestId)?.(FAILED_EXPORT)
        this.exportRequests.delete(requestId)
      }
    })
  }

  stop(): Promise<void> {
    return this.host.stop()
  }

  private receive(message: HostToMain): void {
    switch (message.type) {
      case 'host:browser-call': {
        this.browserCall(message)
        break
      }
      case 'host:device-call': {
        const { callId, call } = message
        if (!Number.isSafeInteger(callId) || typeof call !== 'object' || call === null) break
        const run = this.deps.device
        void (
          run
            ? run(call)
            : Promise.resolve<DeviceCallAnswer>({
                error: { code: 'unavailable', message: 'This build has no device host.' },
              })
        ).then((answer) => this.host.post({ type: 'device-result', callId, answer }))
        break
      }

      case 'host:agent-processes':
        if (Array.isArray(message.processes)) {
          this.agentProcesses = message.processes.flatMap((entry) =>
            Number.isSafeInteger(entry?.pid) && entry.pid > 1 && Number.isFinite(entry.startedAt)
              ? [{ pid: entry.pid, startedAt: entry.startedAt }]
              : [],
          )
        }
        break
      case 'host:projects':
        if (isStringList(message.paths)) this.deps.onProjects(message.paths)
        break
      case 'host:market-oauth':
        this.deps.onMarketOAuth?.(message.serverId, message.state)
        break
      case 'host:first-start':
        this.deps.onFirstStart?.(message.harnesses)
        break
      case 'host:artifacts-changed':
        this.contents.clear()
        this.deps.onArtifactsChanged?.()
        break
      case 'host:sessions-ended':
        if (isStringList(message.sessionIds)) this.deps.onSessionsEnded(message.sessionIds)
        break
      case 'host:auth-commands':
        if (isStringList(message.commands)) this.deps.onAuthCommands(message.commands)
        break
      case 'host:computer-app-allow':
        if (isComputerApp(message.app)) this.deps.onComputerAppAllowed?.(message.app)
        break
      case 'host:attention':
        this.deps.onAttention(message)
        break
      case 'host:badge':
        if (typeof message.count === 'number') this.deps.onBadge(message.count)
        break
      case 'host:waiting':
        if (typeof message.sessions === 'object' && message.sessions !== null) {
          this.deps.onWaiting?.(message.sessions)
        }
        break
      case 'host:seen':
        if (typeof message.sessionId === 'string') this.deps.onSeen?.(message.sessionId)
        break
      case 'host:busy-changed':
        if (isCount(message.running) && isCount(message.waiting)) {
          this.deps.onBusy({ running: message.running, waiting: message.waiting })
        }
        break
      case 'host:routines-working':
        if (typeof message.working === 'boolean') this.deps.onRoutinesWorking(message.working)
        break
      case 'host:busy': {
        const resolve = this.busyRequests.get(message.requestId)
        if (!resolve) break
        this.busyRequests.delete(message.requestId)
        resolve(Array.isArray(message.sessions) ? message.sessions.filter(isBusySession) : [])
        break
      }
      case 'host:granted':
        this.grants.answered(message.requestId)
        break
      case 'host:report': {
        const resolve = this.reportRequests.get(message.requestId)
        if (!resolve) break
        this.reportRequests.delete(message.requestId)
        resolve(reportBuildResult(message.result))
        break
      }
      case 'host:artifact-content': {
        const resolve = this.contentRequests.get(message.requestId)
        if (!resolve) break
        this.contentRequests.delete(message.requestId)
        resolve(isContentResult(message.result) ? message.result : { kind: 'failed' })
        break
      }
      case 'host:artifact-list': {
        const resolve = this.listRequests.get(message.requestId)
        if (!resolve) break
        this.listRequests.delete(message.requestId)
        resolve(listedArtifacts(message.result))
        break
      }
      case 'host:artifact-export': {
        const resolve = this.exportRequests.get(message.requestId)
        if (!resolve) break
        this.exportRequests.delete(message.requestId)
        resolve(isExportResult(message.result) ? message.result : FAILED_EXPORT)
        break
      }
      case 'host:artifact-import': {
        const resolve = this.importRequests.get(message.requestId)
        if (!resolve) break
        this.importRequests.delete(message.requestId)
        resolve(isImportAnswer(message.result) ? message.result : UNAVAILABLE)
        break
      }
      case 'host:artifact-runtime-answer': {
        const deliver = this.runtimeRequests.get(message.requestId)
        if (!deliver) break
        if (isRuntimeAnswer(message.answer)) deliver(message.answer)
        else {
          log.warn('The host answered a page with something that is not an answer')
          deliver(errorAnswer({ v: 1, id: '' }, 'failed', 'Kettu could not answer.'))
        }
        break
      }
      case 'host:media-grant':
        if (isMediaGrant(message.grant)) this.deps.onMediaGrant(message.grant)
        break
      case 'host:media-revoke':
        if (message.sessionId === null || typeof message.sessionId === 'string') {
          this.deps.onMediaRevoke(message.sessionId)
        }
        break
      case 'host:browser-origin-decide': {
        const { sessionId, requestId, decision } = message
        if (
          typeof sessionId === 'string' &&
          Number.isSafeInteger(requestId) &&
          isOriginDecision(decision)
        ) {
          this.deps.onOriginDecided?.(sessionId, requestId, decision)
        }
        break
      }
      case 'host:service-port': {
        const port = message.port
        this.deps.onServicePort?.(
          typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port < 65_536
            ? port
            : null,
        )
        break
      }
      default:
        log.warn(`Ignored unknown message "${(message as { type: string }).type}"`)
    }
  }

  /** Runs a call on the session's page and posts its answer; a page that fails says why. */
  private browserCall(message: Extract<HostToMain, { type: 'host:browser-call' }>): void {
    const { callId, sessionId, tool, args, projectPath } = message
    if (
      !Number.isSafeInteger(callId) ||
      typeof sessionId !== 'string' ||
      typeof tool !== 'string' ||
      typeof args !== 'object' ||
      args === null
    ) {
      return
    }
    const run = this.deps.browser
    const answer: Promise<BrowserCallAnswer> = run
      ? run({
          callId,
          sessionId,
          tool: tool as BrowserCallRequest['tool'],
          args,
          projectPath: typeof projectPath === 'string' ? projectPath : '',
        })
      : Promise.resolve({
          error: { code: 'no_page', message: 'This build drives no browser.' },
        })
    void answer.then(
      (result) => {
        this.host.post(
          'result' in result
            ? { type: 'browser-result', callId, result: result.result }
            : { type: 'browser-result', callId, error: result.error },
        )
        return undefined
      },
      (error: unknown) => {
        log.warn(`Could not run browser call ${tool}: ${(error as Error).message}`)
        this.host.post({
          type: 'browser-result',
          callId,
          error: { code: 'invalid', message: (error as Error).message },
        })
      },
    )
  }

  private exited(clean: boolean): void {
    for (const resolve of this.busyRequests.values()) resolve([])
    this.busyRequests.clear()
    this.grants.failAll()
    for (const resolve of this.contentRequests.values()) resolve({ kind: 'failed' })
    this.contentRequests.clear()
    this.contents.clear()
    for (const resolve of this.importRequests.values()) resolve(UNAVAILABLE)
    this.importRequests.clear()
    for (const resolve of this.exportRequests.values()) resolve(FAILED_EXPORT)
    this.exportRequests.clear()
    for (const resolve of this.listRequests.values()) resolve(null)
    this.listRequests.clear()
    for (const deliver of [...this.runtimeRequests.values()]) {
      deliver(errorAnswer({ v: 1, id: '' }, 'failed', 'Kettu stopped before it answered.'))
    }
    this.runtimeRequests.clear()
    this.deps.onMediaRevoke(null)
    this.deps.onServicePort?.(null)
    this.deps.onRoutinesWorking(false)
    this.deps.onBadge(0)
    this.deps.onBusy({ running: 0, waiting: 0 })
    this.deps.onDown?.()
    const roots = this.agentProcesses
    this.agentProcesses = []
    // After a clean stop the host has stopped every agent itself, or left it in its own record.
    if (clean || roots.length === 0) return
    log.warn(`Stopping ${roots.length} agent process tree(s) left by the host`)
    // They ran until the host died a moment ago.
    const seenAt = Date.now()
    const trees = roots.map((root) => ({ ...root, seenAt }))
    stopTrees(processControl(process.platform), trees, GRACE_MS).then(
      ({ failures }) => {
        for (const { target, error } of failures) log.warn(`Could not stop ${target}: ${error}`)
      },
      (error: unknown) => log.warn(`Could not stop the agents: ${(error as Error).message}`),
    )
  }
}
