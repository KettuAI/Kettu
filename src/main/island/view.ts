// The notch island's view, built by main from what each host reports: its rows in the order to
// show them, the requests that wait with the options the island may answer, the summary, and
// every word in the current language. The helper sorts, counts and words nothing itself.

import { basename, isAbsolute, relative } from 'node:path'
import type {
  AgentOptions,
  AgentStatus,
  PlanProgress,
  SessionActivity,
  SessionSummary,
} from '@shared/agent-host'
import type { BrowserOriginDecision } from '@shared/browser'
import type { ComputerAppDecision } from '@shared/computer-use'
import type { PendingRequest, PendingTool } from '@shared/pending-requests'
import { endingWindow, expiryOf, knownExpiry } from '@shared/prompt-cache'
import {
  groupSessions,
  listed,
  needsYou,
  reachedLimit,
  runningSubagents,
  sessionModel,
} from '@shared/session-groups'
import type { AgentId, PermissionKind, ToolKind } from '@shared/thread'
import type { TurnPhase } from '@shared/turn-phase'
import type { StepState } from '@shared/workflow'
import { KETTU_SERVER, mcpCallOf } from '@shared/mcp-call'
import type { UpdateStatus } from '@shared/updates'
import { islandT, kettuToolT } from '../i18n'
import { buildNotices, type NoticeAction } from './notices'
import { limitLabel, limitPhrase } from './windows'
import type {
  IslandGroup,
  IslandHost,
  IslandNotice,
  IslandPhase,
  IslandOptionStyle,
  IslandRequest,
  IslandRequestKind,
  IslandRow,
  IslandStatus,
  IslandSummary,
  IslandView,
} from './protocol'

/** Sessions that finished out of view, listed after the running ones. */
const FINISHED_ROWS = 5
/** The latest other sessions of the last day, listed after the rest. */
const IDLE_ROWS = 6
const IDLE_WITHIN_MS = 24 * 60 * 60_000
const MAX_REQUEST_LINES = 6
const MAX_LINE_CHARS = 300

/** What one host reports, as the bridge keeps it. */
export interface HostState {
  /** The key its rows and requests carry: `local` for this computer. */
  key: string
  host: IslandHost | null
  sessions: ReadonlyMap<string, SessionSummary>
  agents: ReadonlyMap<AgentId, AgentStatus>
  options: ReadonlyMap<AgentId, AgentOptions>
  /** What waits in each session that waits, as last read. */
  requests: ReadonlyMap<string, { requests: PendingRequest[]; askedAt: Record<string, number> }>
  /** Each task, by id, for its steps' rows and for what it waits for. */
  tasks: ReadonlyMap<string, IslandTaskState>
}

/** What the island keeps of a task. */
export interface IslandTaskState {
  title: string
  /**
   * It waits for the user's answer in Kettu: a document to review or a step of their own. A step
   * that is stuck or waits for a plan limit is no request.
   */
  asksYou: boolean
  steps: { id: string; name: string; state: StepState; sessionId: string | null }[]
  updatedAt: number
}

/** A call the island's answer turns into, on the host of its request. */
export type HostAnswer =
  | {
      method: 'permissions.respond'
      params: {
        sessionId: string
        requestId: string
        optionId?: string
        answers?: { question: number; choices: number[] }[]
      }
    }
  | {
      method: 'browser.answerOrigin'
      params: { sessionId: string; entryId: string; decision: BrowserOriginDecision }
    }
  | {
      method: 'computer.answerApp'
      params: { sessionId: string; entryId: string; decision: ComputerAppDecision }
    }

/** What main keeps of a request it sent: where it is and what each option does. */
export interface SentRequest {
  hostKey: string
  sessionId: string
  answers: ReadonlyMap<string, HostAnswer>
}

export interface BuiltView {
  view: IslandView
  rows: ReadonlyMap<string, { hostKey: string; sessionId: string }>
  requests: ReadonlyMap<string, SentRequest>
  /** What each request belongs to, which opening it in Kettu goes to. */
  owners: ReadonlyMap<string, RequestOwner>
  /** What each notice does when clicked. */
  notices: ReadonlyMap<string, NoticeAction>
}

export type RequestOwner =
  { hostKey: string; sessionId: string; taskId?: never } | { hostKey: string; taskId: string }

const ORIGIN_DECISIONS: BrowserOriginDecision[] = ['session', 'project', 'deny']
const APP_DECISIONS: ComputerAppDecision[] = ['session', 'always', 'deny']

const TOOL_KEY = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'other',
  fetch: 'fetch',
  switch_mode: 'switchMode',
  other: 'other',
} as const satisfies Record<ToolKind, string>

const FILE_KINDS = new Set<ToolKind>(['read', 'edit', 'delete', 'move'])

const OPTION_STYLE: Record<PermissionKind, IslandOptionStyle> = {
  allow_once: 'allow_once',
  allow_always: 'allow_always',
  reject_once: 'deny',
  reject_always: 'deny',
}

/**
 * The permission card's answers, as the window's card has them: its first denial, then one allow
 * of each kind, once first. Anything else is answered in Kettu.
 */
function permissionChoices<T extends { kind: PermissionKind }>(options: readonly T[]): T[] {
  const deny =
    options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  const once = options.find((o) => o.kind === 'allow_once')
  const always = options.find((o) => o.kind === 'allow_always')
  return [deny, once, always].filter((o) => o !== undefined)
}

/**
 * The card's words for an answer, the window's, so the three fit on one line; an agent's own may
 * spell out a scope at length, which Kettu shows. Null for an answer that keeps its own words.
 */
function answerLabel(style: IslandOptionStyle): string | null {
  switch (style) {
    case 'deny':
      return islandT('request.answer.deny')
    case 'allow_once':
      return islandT('request.answer.allowOnce')
    case 'allow_always':
      return islandT('request.answer.allowAlways')
    default:
      return null
  }
}

/** The permission card's order: any other option, the denials, then the allows, once first. */
const CARD_ORDER: Record<IslandOptionStyle, number> = {
  normal: 0,
  recommended: 0,
  deny: 1,
  allow_once: 2,
  allow_always: 3,
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line
}

/** A file as the project names it, or as it is when it lies outside. */
function shownPath(path: string, projectPath: string): string {
  if (!isAbsolute(path)) return path
  const inside = relative(projectPath, path)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path
}

/** An MCP tool as the thread names it: Kettu's own by what it does, another's as `server: tool`. */
function mcpName(title: string): string | null {
  const call = mcpCallOf(title)
  if (!call) return null
  if (call.server !== KETTU_SERVER) {
    return islandT('line.mcp', { server: call.server, tool: call.tool })
  }
  return kettuToolT(call.tool as never, { defaultValue: call.tool }) as string
}

/**
 * The command an MCP tool's call runs, for the tools that run one. The hosts keep a call's input as
 * its JSON, or as the command alone when it has one.
 */
function mcpCommand(rawInput: string | null | undefined): string | null {
  const raw = rawInput?.trim()
  if (!raw) return null
  try {
    const input = JSON.parse(raw) as unknown
    if (typeof input !== 'object' || input === null) return null
    const { command } = input as { command?: unknown }
    return typeof command === 'string' && command.trim() ? command : null
  } catch {
    return raw
  }
}

/** A call as one line: "Run pnpm test", "Edit src/app.ts", or its title. */
function toolLine(
  tool: { toolKind: ToolKind; title: string; detail: string | null },
  projectPath: string,
): string {
  const mcp = mcpName(tool.title)
  if (mcp) return tool.detail ? `${mcp} · ${clip(tool.detail)}` : mcp
  const { toolKind, detail } = tool
  if (toolKind === 'execute') {
    return islandT('line.run', { command: clip(detail ?? tool.title.replace(/^run\s+/i, '')) })
  }
  if (FILE_KINDS.has(toolKind) && detail) {
    const key = toolKind as 'read' | 'edit' | 'delete' | 'move'
    return islandT(`line.${key}`, { path: shownPath(detail, projectPath) })
  }
  if ((toolKind === 'search' || toolKind === 'fetch') && detail) {
    return islandT(`line.${toolKind}`, { text: clip(detail) })
  }
  return clip(tool.title)
}

function pendingToolLine(tool: PendingTool, projectPath: string): string {
  const detail =
    tool.toolKind === 'execute'
      ? (tool.rawInput?.split('\n').find((l) => l.trim()) ?? null)
      : (tool.locations[0]?.path ?? null)
  return toolLine({ toolKind: tool.toolKind, title: tool.title, detail }, projectPath)
}

function activityLine(activity: SessionActivity, projectPath: string): string {
  return toolLine(activity, projectPath)
}

/** The option names agents write may hold `code` spans, which the island shows as plain text. */
function plain(name: string): string {
  return name.replace(/`/g, '')
}

interface BuiltRequest {
  request: IslandRequest
  answers: Map<string, HostAnswer>
}

/** A request as the island shows it, with the calls its options make. */
function buildRequest(
  pending: PendingRequest,
  sessionId: string,
  rowKey: string,
  projectPath: string,
  askedAt: number | null,
): BuiltRequest {
  const key = `${rowKey}#${pending.entryId}`
  const answers = new Map<string, HostAnswer>()
  const base = { key, row: rowKey, task: null, askedAt }
  const make = (
    kind: IslandRequestKind,
    title: string,
    lines: string[],
    code: boolean,
    options: IslandRequest['options'] = [],
  ): BuiltRequest => ({
    request: { ...base, kind, title, lines: lines.slice(0, MAX_REQUEST_LINES), code, options },
    answers,
  })
  switch (pending.kind) {
    case 'tool': {
      const { tool, permission } = pending
      const { requestId } = permission
      if (permission.elicitation) {
        const { server, kind } = permission.elicitation
        const message = kind === 'form' ? permission.elicitation.message : ''
        return make(
          'kettu',
          islandT(kind === 'form' ? 'request.form' : 'request.page', { server }),
          message ? [clip(message)] : [],
          false,
        )
      }
      if (permission.questions) {
        const [first] = permission.questions
        if (!first || permission.questions.length > 1 || first.multiSelect || first.secret) {
          const many = permission.questions.length > 1
          return make(
            'kettu',
            islandT(many ? 'request.questions' : 'request.question'),
            first ? [clip(first.question)] : [],
            false,
          )
        }
        const options = first.options.map((option, i) => {
          answers.set(`q${i}`, {
            method: 'permissions.respond',
            params: { sessionId, requestId, answers: [{ question: 0, choices: [i] }] },
          })
          return { id: `q${i}`, label: clip(option.label), style: 'normal' as const }
        })
        return make('question', islandT('request.question'), [clip(first.question)], false, options)
      }
      // A plan's answers that go with a note are written in the window.
      const choices = permission.plan
        ? permission.options.filter((o) => !o.note)
        : permissionChoices(permission.options)
      const options = choices.map((option) => {
        answers.set(option.id, {
          method: 'permissions.respond',
          params: { sessionId, requestId, optionId: option.id },
        })
        const style: IslandOptionStyle =
          permission.plan && option.preferred ? 'recommended' : OPTION_STYLE[option.kind]
        const label = permission.plan ? null : answerLabel(style)
        return { id: option.id, label: label ?? clip(plain(option.name)), style }
      })
      if (permission.plan) {
        const lines = permission.plan.markdown
          .split('\n')
          .map((line) => clip(line.replace(/^\s*(#+|[-*]|\d+\.)\s*/, '')))
          .filter(Boolean)
        return make('plan', islandT('request.plan'), lines, false, options)
      }
      options.sort((a, b) => CARD_ORDER[a.style] - CARD_ORDER[b.style])
      const mcp = mcpName(tool.title)
      if (mcp) {
        const command = mcpCommand(tool.rawInput)
        const lines = command
          ? command
              .split('\n')
              .filter((l) => l.trim())
              .map(clip)
          : []
        return make('permission', mcp, lines, command !== null, options)
      }
      const title = islandT(`request.tool.${TOOL_KEY[tool.toolKind]}`)
      if (tool.toolKind === 'execute') {
        const command = tool.rawInput ?? tool.title.replace(/^run\s+/i, '')
        const lines = command.split('\n').filter((l) => l.trim())
        return make('permission', title, lines.map(clip), true, options)
      }
      const files = FILE_KINDS.has(tool.toolKind)
        ? tool.locations.map((l) => shownPath(l.path, projectPath))
        : []
      return make('permission', title, files.length ? files : [clip(tool.title)], false, options)
    }
    case 'origin': {
      const options = ORIGIN_DECISIONS.map((decision) => {
        answers.set(decision, {
          method: 'browser.answerOrigin',
          params: { sessionId, entryId: pending.entryId, decision },
        })
        const style: IslandOptionStyle = decision === 'deny' ? 'deny' : 'normal'
        return { id: decision, label: islandT(`request.originDecision.${decision}`), style }
      })
      return make('origin', islandT('request.origin'), [pending.origin], false, options)
    }
    case 'app': {
      const options = APP_DECISIONS.map((decision) => {
        answers.set(decision, {
          method: 'computer.answerApp',
          params: { sessionId, entryId: pending.entryId, decision },
        })
        const style: IslandOptionStyle = decision === 'deny' ? 'deny' : 'normal'
        const label = islandT(`request.appDecision.${decision}`, { app: pending.app })
        return { id: decision, label, style }
      })
      return make('app', islandT('request.app'), [pending.app], false, options)
    }
    case 'setup':
      return make('kettu', islandT('request.setup'), [], false)
    case 'step':
      return make('kettu', islandT('request.step'), pending.target ? [pending.target] : [], false)
    case 'other':
      return make('kettu', islandT('request.other'), [], false)
  }
}

/** What a waiting session's row says it waits for: its first request. */
function waitingLine(pending: PendingRequest | undefined, projectPath: string): string {
  switch (pending?.kind) {
    case undefined:
      return islandT('request.other')
    case 'tool': {
      const question = pending.permission.questions?.[0]?.question
      if (question) return islandT('line.question', { question: clip(question) })
      if (pending.permission.plan) return islandT('request.plan')
      if (pending.permission.elicitation) {
        const { server, kind } = pending.permission.elicitation
        return islandT(kind === 'form' ? 'request.form' : 'request.page', { server })
      }
      return pendingToolLine(pending.tool, projectPath)
    }
    case 'origin':
      return islandT('line.origin', { origin: pending.origin })
    case 'app':
      return islandT('line.app', { app: pending.app })
    case 'setup':
      return islandT('request.setup')
    case 'step':
      return islandT('request.step')
    case 'other':
      return islandT('request.other')
  }
}

interface Listed {
  state: HostState
  summary: SessionSummary
}

function rowKey(state: HostState, sessionId: string): string {
  return state.host ? `${state.key}/${sessionId}` : sessionId
}

const PHASES: Record<TurnPhase['phase'], IslandPhase | null> = {
  thinking: 'think',
  execute: 'execute',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  edit: 'edit',
  writing: 'write',
  compacting: 'compact',
  working: 'execute',
  approval: null,
  question: null,
}

const TOOL_PHASES: Partial<Record<ToolKind, IslandPhase>> = {
  execute: 'execute',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
}

/** What a running turn does now: its summary's phase, else what its tool call does. */
function phaseOf(summary: SessionSummary): IslandPhase {
  if (summary.phase) return PHASES[summary.phase] ?? 'execute'
  const kind = summary.activity?.toolKind
  return (kind && TOOL_PHASES[kind]) || 'execute'
}

/** What a running turn does, as its row's line: compacting, its tool call, thinking or writing. */
function runningLine(summary: SessionSummary): string {
  const phase = phaseOf(summary)
  if (phase === 'compact') return islandT('line.compacting')
  if (summary.activity) return activityLine(summary.activity, summary.projectPath)
  if (phase === 'think') return islandT('line.thinking')
  if (phase === 'write') return islandT('line.writing')
  return islandT(summary.origin === 'routine' ? 'line.routine' : 'line.working')
}

/**
 * The plan step a session is on, from 1: the one in progress, else the next to do, else the last.
 * Between steps the summary names no step, so the next is the one after those done, which is the
 * chip's next pending step whenever the steps are finished in order.
 */
function planStep({ done, total, current }: PlanProgress): number {
  return current ? current.index + 1 : Math.max(1, Math.min(done + 1, total))
}

function modelName(options: AgentOptions | undefined, model: string | null): string | null {
  const option = sessionModel(options, model)
  if (!option || model === null) return model
  return option.choices?.find((c) => c.value === model)?.name ?? model
}

function buildRow(
  { state, summary }: Listed,
  group: IslandGroup,
  now: number,
  requests: { requests: PendingRequest[]; askedAt: Record<string, number> } | undefined,
): IslandRow {
  const agent = state.agents.get(summary.agentId)
  const options = state.options.get(summary.agentId)
  const limit = reachedLimit(agent, sessionModel(options, summary.model), now)
  const waiting = needsYou(summary)
  const status: IslandStatus = waiting
    ? 'waiting'
    : summary.status === 'running'
      ? 'running'
      : summary.status === 'starting'
        ? 'starting'
        : summary.status === 'auth_required'
          ? 'sign_in'
          : summary.attention === 'error' || summary.status === 'failed'
            ? 'failed'
            : limit
              ? 'limited'
              : summary.attention === 'unread'
                ? 'unread'
                : 'idle'
  const asked = requests ? Object.values(requests.askedAt) : []
  const since =
    status === 'waiting' && asked.length > 0
      ? Math.min(...asked)
      : status === 'running'
        ? (summary.turnStartedAt ?? summary.updatedAt)
        : summary.updatedAt
  const activity = summary.activity ?? null
  const agentName = agent?.name ?? summary.agentId
  let line: string
  switch (status) {
    case 'waiting':
      line = waitingLine(requests?.requests[0], summary.projectPath)
      break
    case 'running':
      line = runningLine(summary)
      break
    case 'sign_in':
      line = islandT('line.signIn', { agent: agentName })
      break
    case 'limited':
      line = islandT('line.limited', { window: limitPhrase(limit!) })
      break
    case 'starting':
      line = islandT('line.starting')
      break
    default:
      line = islandT(`line.${status}`)
  }
  const parent = summary.task
    ? { kind: 'task' as const, title: state.tasks.get(summary.task.taskId)?.title ?? null }
    : summary.parentId
      ? { kind: 'session' as const, title: state.sessions.get(summary.parentId)?.title ?? null }
      : null
  const turnRuns = status === 'running'
  const expiry = turnRuns
    ? null
    : knownExpiry(expiryOf(summary.agentId, summary.cache, summary.model, agent?.account ?? null))
  const phase = turnRuns ? phaseOf(summary) : null
  // Hidden for an offline host, as the sidebar's badge is: what it last said is stale.
  const running = state.host?.offline ? 0 : runningSubagents(state.sessions.values(), summary.id)
  return {
    key: rowKey(state, summary.id),
    sessionId: summary.id,
    host: state.host,
    parent,
    title: summary.title ?? '',
    project: summary.scratch ? '' : basename(summary.projectPath),
    agent: {
      id: summary.agentId,
      name: agentName,
      harness: agent?.harnessId ?? summary.agentId,
      color: agent?.color ?? null,
    },
    model: modelName(options, summary.model),
    group,
    status,
    since,
    line,
    toolSince: status === 'running' ? (activity?.startedAt ?? null) : null,
    toolKind: status === 'running' ? (activity?.toolKind ?? null) : null,
    turnStartedAt: summary.turnStartedAt ?? null,
    plan: summary.plan
      ? {
          done: summary.plan.done,
          total: summary.plan.total,
          step: planStep(summary.plan),
          current: summary.plan.current?.text ?? null,
        }
      : null,
    subagents:
      running > 0 ? { running, text: islandT('line.subagents', { count: running }) } : null,
    limit: limit ? { label: limitLabel(limit), resetsAt: limit.resetsAt } : null,
    phase,
    cache: expiry
      ? {
          expiresAt: expiry.expiresAt,
          endingMs: endingWindow(expiry.ttl),
          estimate: expiry.estimate,
        }
      : null,
  }
}

function buildSummary(
  rows: readonly IslandRow[],
  requests: readonly IslandRequest[],
  all: readonly SessionSummary[],
  now: number,
): IslandSummary {
  const count = (status: IslandStatus) => rows.filter((row) => row.status === status).length
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return {
    running: count('running'),
    waiting: count('waiting') + count('sign_in') + requests.filter((r) => r.task).length,
    failed: count('failed'),
    today: all.filter((s) => listed(s) && s.parentId === null && s.updatedAt >= +midnight).length,
  }
}

/**
 * The tasks that wait for the user on a step of their own, a review or a person's step; a step
 * whose session asks is that session's request already.
 */
function taskRequests(state: HostState): { request: IslandRequest; taskId: string }[] {
  if (state.host?.offline) return []
  const out: { request: IslandRequest; taskId: string; at: number }[] = []
  for (const [taskId, task] of state.tasks) {
    if (!task.asksYou) continue
    const step = task.steps.find((s) => s.state === 'needs_you')
    const asking = step?.sessionId ? state.sessions.get(step.sessionId) : undefined
    if (asking && needsYou(asking)) continue
    out.push({
      taskId,
      at: task.updatedAt,
      request: {
        key: `task:${state.key}/${taskId}`,
        row: null,
        task: { title: task.title, step: step?.name ?? null },
        kind: 'kettu',
        title: islandT('request.task'),
        lines: [],
        code: false,
        options: [],
        askedAt: task.updatedAt,
      },
    })
  }
  return out
}

/** The whole view of every host, and what main needs to act on what the helper sends back. */
export function buildView(
  hosts: readonly HostState[],
  now: number,
  update: UpdateStatus | null = null,
): BuiltView {
  const owners = new Map<SessionSummary, HostState>()
  for (const state of hosts)
    for (const summary of state.sessions.values()) owners.set(summary, state)
  const all = [...owners.keys()]
  const groups = groupSessions(all, { finished: FINISHED_ROWS, recent: 0 })
  const shown = [...groups.needsYou, ...groups.running, ...groups.finished]
  const taken = new Set(shown)
  const idle = all
    .filter((s) => listed(s) && !taken.has(s) && s.parentId === null)
    .filter((s) => now - s.updatedAt < IDLE_WITHIN_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, IDLE_ROWS)
  const rows: IslandRow[] = []
  const rowMap = new Map<string, { hostKey: string; sessionId: string }>()
  const requests: IslandRequest[] = []
  const sent = new Map<string, SentRequest>()
  const requestOwners = new Map<string, RequestOwner>()
  const listedIn = new Map<SessionSummary, IslandGroup>()
  for (const s of groups.needsYou) listedIn.set(s, 'needs_you')
  for (const s of groups.running) listedIn.set(s, 'running')
  for (const s of groups.finished) listedIn.set(s, 'finished')
  for (const summary of [...shown, ...idle]) {
    const state = owners.get(summary)!
    const waiting = needsYou(summary) ? state.requests.get(summary.id) : undefined
    const row = buildRow({ state, summary }, listedIn.get(summary) ?? 'idle', now, waiting)
    rows.push(row)
    rowMap.set(row.key, { hostKey: state.key, sessionId: summary.id })
    // An offline host's requests cannot be answered until it is back.
    if (!waiting || state.host?.offline) continue
    for (const pending of waiting.requests) {
      const built = buildRequest(
        pending,
        summary.id,
        row.key,
        summary.projectPath,
        waiting.askedAt[pending.entryId] ?? null,
      )
      requests.push(built.request)
      sent.set(built.request.key, {
        hostKey: state.key,
        sessionId: summary.id,
        answers: built.answers,
      })
      requestOwners.set(built.request.key, { hostKey: state.key, sessionId: summary.id })
    }
  }
  for (const state of hosts) {
    for (const { request, taskId } of taskRequests(state)) {
      requests.push(request)
      requestOwners.set(request.key, { hostKey: state.key, taskId })
    }
  }
  // The oldest request first, as the island answers them in turn.
  requests.sort((a, b) => (a.askedAt ?? Infinity) - (b.askedAt ?? Infinity))
  const notices = buildNotices(update, hosts, now)
  return {
    view: {
      rows,
      requests,
      notices: notices.notices,
      summary: buildSummary(rows, requests, all, now),
    },
    rows: rowMap,
    requests: sent,
    owners: requestOwners,
    notices: notices.actions,
  }
}

export interface ViewChange {
  rows: IslandRow[]
  removedRows: string[]
  order?: string[]
  requests: IslandRequest[]
  removedRequests: string[]
  requestOrder?: string[]
  notices?: IslandNotice[]
  summary?: IslandSummary
}

function keyed<T extends { key: string }>(items: readonly T[]): Map<string, string> {
  return new Map(items.map((item) => [item.key, JSON.stringify(item)]))
}

function sameOrder(a: readonly { key: string }[], b: readonly { key: string }[]): boolean {
  return a.length === b.length && a.every((item, i) => item.key === b[i]!.key)
}

/** What changed from `before` to `after`; null when nothing did. */
export function diffView(before: IslandView, after: IslandView): ViewChange | null {
  const oldRows = keyed(before.rows)
  const oldRequests = keyed(before.requests)
  const newRows = new Set(after.rows.map((row) => row.key))
  const newRequests = new Set(after.requests.map((request) => request.key))
  const change: ViewChange = {
    rows: after.rows.filter((row) => oldRows.get(row.key) !== JSON.stringify(row)),
    removedRows: [...oldRows.keys()].filter((key) => !newRows.has(key)),
    requests: after.requests.filter((r) => oldRequests.get(r.key) !== JSON.stringify(r)),
    removedRequests: [...oldRequests.keys()].filter((key) => !newRequests.has(key)),
  }
  if (!sameOrder(before.rows, after.rows)) change.order = after.rows.map((row) => row.key)
  if (!sameOrder(before.requests, after.requests)) {
    change.requestOrder = after.requests.map((request) => request.key)
  }
  if (JSON.stringify(before.notices) !== JSON.stringify(after.notices)) {
    change.notices = after.notices
  }
  if (JSON.stringify(before.summary) !== JSON.stringify(after.summary)) {
    change.summary = after.summary
  }
  const empty =
    change.rows.length === 0 &&
    change.removedRows.length === 0 &&
    change.requests.length === 0 &&
    change.removedRequests.length === 0 &&
    !change.order &&
    !change.requestOrder &&
    !change.notices &&
    !change.summary
  return empty ? null : change
}
