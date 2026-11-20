// The notch island's view, built by main from what each host reports: its rows in the order to
// show them, the requests that wait with the options the island may answer, the summary, and
// every word in the current language. The helper sorts, counts and words nothing itself.

import { basename, isAbsolute, relative } from 'node:path'
import type { AgentOptions, AgentStatus, SessionActivity, SessionSummary } from '@shared/agent-host'
import type { BrowserOriginDecision } from '@shared/browser'
import type { ComputerAppDecision } from '@shared/computer-use'
import type { PendingRequest, PendingTool } from '@shared/pending-requests'
import { limitLevel } from '@shared/plan-limits'
import {
  groupSessions,
  limitRows,
  listed,
  needsYou,
  reachedLimit,
  sessionModel,
} from '@shared/session-groups'
import type { AgentId, PermissionKind, ToolKind } from '@shared/thread'
import { islandT } from '../i18n'
import type {
  IslandGroup,
  IslandHost,
  IslandLimits,
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
/** The latest other sessions, which the island folds into its last row. */
const IDLE_ROWS = 5
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
  /** Each task's title, by id. */
  tasks: ReadonlyMap<string, string>
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
}

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

/** An MCP tool's server and name from a title such as `mcp__github__create_issue`. */
function mcpCall(title: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(title)
  return match ? { server: match[1]!, tool: match[2]! } : null
}

/** A call as one line: "Run pnpm test", "Edit src/app.ts", or its title. */
function toolLine(
  tool: { toolKind: ToolKind; title: string; detail: string | null },
  projectPath: string,
): string {
  const mcp = mcpCall(tool.title)
  if (mcp) return islandT('line.mcp', mcp)
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
  const base = { key, row: rowKey, askedAt }
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
        : permission.options
      const options = choices.map((option) => {
        answers.set(option.id, {
          method: 'permissions.respond',
          params: { sessionId, requestId, optionId: option.id },
        })
        const style: IslandOptionStyle =
          permission.plan && option.preferred ? 'recommended' : OPTION_STYLE[option.kind]
        return { id: option.id, label: clip(plain(option.name)), style }
      })
      if (permission.plan) {
        const lines = permission.plan.markdown
          .split('\n')
          .map((line) => clip(line.replace(/^\s*(#+|[-*]|\d+\.)\s*/, '')))
          .filter(Boolean)
        return make('plan', islandT('request.plan'), lines, false, options)
      }
      options.sort((a, b) => CARD_ORDER[a.style] - CARD_ORDER[b.style])
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
      line = activity
        ? activityLine(activity, summary.projectPath)
        : islandT(summary.origin === 'routine' ? 'line.routine' : 'line.working')
      break
    case 'sign_in':
      line = islandT('line.signIn', { agent: agentName })
      break
    case 'limited':
      line = islandT('line.limited', { window: limit!.label })
      break
    case 'starting':
      line = islandT('line.starting')
      break
    default:
      line = islandT(`line.${status}`)
  }
  const parent = summary.task
    ? { kind: 'task' as const, title: state.tasks.get(summary.task.taskId) ?? null }
    : summary.parentId
      ? { kind: 'session' as const, title: state.sessions.get(summary.parentId)?.title ?? null }
      : null
  const running = [...state.sessions.values()].filter(
    (s) => s.origin === 'subagent' && s.parentId === summary.id && s.status === 'running',
  ).length
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
          current: summary.plan.current?.text ?? null,
        }
      : null,
    subagents:
      running > 0 ? { running, text: islandT('line.subagents', { count: running }) } : null,
    limit: limit ? { label: limit.label, resetsAt: limit.resetsAt } : null,
  }
}

/** The order an agent's windows read in: the short one, the week, then the rest. */
const WINDOW_ORDER = ['five_hour', 'seven_day']
const SHOWN_LIMIT_AGENTS = 2
const SHOWN_WINDOWS = 3

/**
 * The plan windows of the agents on a plan, each agent once however many hosts have it, the
 * fullest first. A window that has reset reads as empty until the agent reads it again.
 */
function agentLimits(hosts: readonly HostState[], now: number): IslandLimits[] {
  const seen = new Set<string>()
  const groups: (IslandLimits & { fullest: number })[] = []
  for (const state of hosts) {
    for (const agent of state.agents.values()) {
      if (agent.hidden || agent.disabled || agent.registered === false) continue
      const key = `${agent.harnessId}/${agent.account?.label ?? agent.name}`
      if (seen.has(key)) continue
      const rank = (window: string) => {
        const i = WINDOW_ORDER.indexOf(window)
        return i < 0 ? WINDOW_ORDER.length : i
      }
      const windows = agent.limits
        .filter((limit) => limit.usedPercent !== null)
        .sort((a, b) => rank(a.window) - rank(b.window))
        .slice(0, SHOWN_WINDOWS)
        .map((limit) => {
          const reset = limit.resetsAt !== null && limit.resetsAt <= now
          const usedPercent = reset ? 0 : Math.round(limit.usedPercent!)
          return {
            label: islandT(`limit.${limit.window}`, { defaultValue: limit.label }),
            usedPercent,
            resetsAt: reset ? null : limit.resetsAt,
            level: reset ? ('ok' as const) : limitLevel(limit),
          }
        })
      if (windows.length === 0) continue
      seen.add(key)
      groups.push({
        agent: { name: agent.name, harness: agent.harnessId, color: agent.color ?? null },
        windows,
        fullest: Math.max(...windows.map((w) => w.usedPercent)),
      })
    }
  }
  return groups
    .sort((a, b) => b.fullest - a.fullest)
    .slice(0, SHOWN_LIMIT_AGENTS)
    .map(({ agent, windows }) => ({ agent, windows }))
}

function buildSummary(rows: readonly IslandRow[], hosts: readonly HostState[], now: number) {
  const count = (status: IslandStatus) => rows.filter((row) => row.status === status).length
  const limits = hosts.flatMap((state) => limitRows([...state.agents.values()], now))
  const tightest =
    limits.find((row) => row.limit.state === 'reached') ??
    limits.sort((a, b) => (b.limit.usedPercent ?? 0) - (a.limit.usedPercent ?? 0))[0]
  const summary: IslandSummary = {
    limits: agentLimits(hosts, now),
    running: count('running'),
    waiting: count('waiting'),
    failed: count('failed'),
    limit: tightest
      ? {
          agent: tightest.agent.name,
          label: tightest.limit.label,
          usedPercent: tightest.limit.usedPercent,
          reached: tightest.limit.state === 'reached',
          resetsAt: tightest.limit.resetsAt,
        }
      : null,
  }
  return summary
}

/** The whole view of every host, and what main needs to act on what the helper sends back. */
export function buildView(hosts: readonly HostState[], now: number): BuiltView {
  const owners = new Map<SessionSummary, HostState>()
  for (const state of hosts)
    for (const summary of state.sessions.values()) owners.set(summary, state)
  const all = [...owners.keys()]
  const groups = groupSessions(all, { finished: FINISHED_ROWS, recent: 0 })
  const shown = [...groups.needsYou, ...groups.running, ...groups.finished]
  const taken = new Set(shown)
  const idle = all
    .filter((s) => listed(s) && !taken.has(s) && s.parentId === null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, IDLE_ROWS)
  const rows: IslandRow[] = []
  const rowMap = new Map<string, { hostKey: string; sessionId: string }>()
  const requests: IslandRequest[] = []
  const sent = new Map<string, SentRequest>()
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
    }
  }
  // The oldest request first, as the island answers them in turn.
  requests.sort((a, b) => (a.askedAt ?? Infinity) - (b.askedAt ?? Infinity))
  return {
    view: { rows, requests, summary: buildSummary(rows, hosts, now) },
    rows: rowMap,
    requests: sent,
  }
}

export interface ViewChange {
  rows: IslandRow[]
  removedRows: string[]
  order?: string[]
  requests: IslandRequest[]
  removedRequests: string[]
  requestOrder?: string[]
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
    !change.summary
  return empty ? null : change
}
