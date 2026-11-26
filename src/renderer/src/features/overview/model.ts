// What the Overview page lists: the tasks and top-level sessions that have something to say, each
// in one of four states, with its steps as every view draws them.

import type { SessionOutputs } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { StepState, TaskSummary } from '@shared/workflow'
import { hostOfPath } from '@renderer/lib/host-paths'
import type { SessionNode } from '@renderer/stores/sessions'

/** In the order the page lists them: what is done and waits to be taken comes first. */
export const STATES = ['ready', 'you', 'running', 'stopped'] as const
export type OverviewState = (typeof STATES)[number]

export type StepLook = 'done' | 'running' | 'you' | 'error' | 'waiting' | 'todo'

export interface OverviewStep {
  id: string
  name: string
  look: StepLook
  agentId: AgentId | null
  sessionId: string | null
  startedAt: number | null
  endedAt: number | null
}

interface RowBase {
  key: string
  state: OverviewState
  projectPath: string
  hostId: string | null
  updatedAt: number
}

export type OverviewRow =
  | (RowBase & { kind: 'task'; task: TaskSummary })
  | (RowBase & { kind: 'session'; node: SessionNode })

function taskState(task: TaskSummary): OverviewState | null {
  if (task.archivedAt) return null
  if (task.status !== 'running') return task.unread ? 'ready' : null
  if (task.error) return 'stopped'
  if (task.needsYou) return 'you'
  return 'running'
}

function sessionState(node: SessionNode): OverviewState | null {
  const { summary } = node
  if (node.permissionCount > 0) return 'you'
  if (summary.attention === 'error' || summary.status === 'failed') return 'stopped'
  if (node.running || summary.status === 'starting') return 'running'
  const unread =
    summary.attention === 'unread' || node.children.some((c) => c.summary.attention === 'unread')
  return unread ? 'ready' : null
}

/** The rows of every state, the latest first within each. */
export function overviewRows(
  tasks: Record<string, TaskSummary>,
  sessions: readonly SessionNode[],
): OverviewRow[] {
  const rows: OverviewRow[] = []
  for (const task of Object.values(tasks)) {
    const state = taskState(task)
    if (!state) continue
    rows.push({
      kind: 'task',
      key: `task:${task.id}`,
      state,
      task,
      projectPath: task.projectPath,
      hostId: hostOfPath(task.projectPath),
      updatedAt: task.updatedAt,
    })
  }
  for (const node of sessions) {
    const state = sessionState(node)
    if (!state) continue
    rows.push({
      kind: 'session',
      key: `session:${node.summary.id}`,
      state,
      node,
      projectPath: node.summary.projectPath,
      hostId: hostOfPath(node.summary.projectPath),
      updatedAt: node.summary.updatedAt,
    })
  }
  return rows.sort(
    (a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || b.updatedAt - a.updatedAt,
  )
}

export function countByState(rows: readonly OverviewRow[]): Record<OverviewState, number> {
  const counts: Record<OverviewState, number> = { ready: 0, you: 0, running: 0, stopped: 0 }
  for (const row of rows) counts[row.state]++
  return counts
}

const TASK_LOOK: Record<StepState, StepLook> = {
  done: 'done',
  running: 'running',
  needs_you: 'you',
  error: 'error',
  waiting: 'waiting',
  not_reached: 'todo',
}

/** A task's steps in its workflow's order. */
export function taskSteps(task: TaskSummary, name: (id: string, fallback: string) => string) {
  return task.steps.map((step): OverviewStep => ({
    id: step.id,
    name: name(step.id, step.name),
    look: TASK_LOOK[step.state],
    agentId: step.agentId,
    sessionId: step.sessionId,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  }))
}

/** A session's latest plan as steps; the item in progress takes the session's state. */
export function planSteps(
  outputs: SessionOutputs | null,
  state: OverviewState,
): OverviewStep[] | null {
  const plan = outputs?.plan
  if (!plan || plan.length === 0) return null
  const front: StepLook =
    state === 'you'
      ? 'you'
      : state === 'running'
        ? 'running'
        : state === 'stopped'
          ? 'error'
          : 'waiting'
  return plan.map((item, i) => ({
    id: String(i),
    name: item.content,
    look: item.status === 'completed' ? 'done' : item.status === 'in_progress' ? front : 'todo',
    agentId: null,
    sessionId: null,
    startedAt: null,
    endedAt: null,
  }))
}

/** The step in front: the first that is neither done nor still to come. */
export function frontStep(steps: readonly OverviewStep[] | null): OverviewStep | null {
  return steps?.find((step) => step.look !== 'done' && step.look !== 'todo') ?? null
}

/** How many steps are done, as "3/5". */
export function doneOf(steps: readonly OverviewStep[]): string {
  return `${steps.filter((step) => step.look === 'done').length}/${steps.length}`
}

/** The first line of a reply without its Markdown marks, for a row. */
export function replyLine(reply: string | null | undefined): string | null {
  const line = reply
    ?.split('\n')
    .map((l) =>
      l
        .replace(/^[#>\-*\s]+/, '')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .find((l) => l.length > 0)
  return line || null
}

/** Structured subtitle segments for an Overview row and its full tooltip string. */
export interface RowSubParts {
  project: string | null
  by: string | null
  extra: string | null
  host: string | null
  fullText: string
}

/** Splits a row's subtitle into structured segments and builds its full tooltip text. */
export function rowSubParts(
  facts: { project: string; by: string; host: string | null },
  {
    project = true,
    extra = null,
    separator,
  }: { project?: boolean; extra?: string | null; separator: string },
): RowSubParts {
  const projectName = project && facts.project ? facts.project : null
  const by = facts.by || null
  const extraText = extra || null
  const host = facts.host || null
  const fullText = [projectName, by, extraText, host].filter(Boolean).join(separator)
  return { project: projectName, by, extra: extraText, host, fullText }
}

/** Builds a row hover tooltip that exposes full truncated title and subtitle metadata. */
export function rowTooltip(title: string, subtitle: string): string {
  return subtitle ? `${title}\n${subtitle}` : title
}

// The timeline.

export interface TimelineBar {
  key: string
  name: string
  look: StepLook
  from: number
  to: number
  /** Still going at `to`, which is now. */
  open: boolean
}

/** A task's steps that started, as bars; one at work or waiting runs to now. */
export function taskBars(steps: readonly OverviewStep[], now: number): TimelineBar[] {
  return steps.flatMap((step) => {
    if (step.startedAt === null) return []
    const open = step.endedAt === null && (step.look === 'running' || step.look === 'you')
    return [
      {
        key: step.id,
        name: step.name,
        look: step.look,
        from: step.startedAt,
        to: step.endedAt ?? (open ? now : step.startedAt),
        open,
      },
    ]
  })
}

/** A session's running turn, or its last ended one, as a bar. */
export function sessionBars(
  state: OverviewState,
  updatedAt: number,
  outputs: SessionOutputs | null,
  name: string,
  now: number,
): TimelineBar[] {
  if (state === 'running' || state === 'you') {
    const from = outputs?.turnStartedAt ?? updatedAt
    return [
      { key: 'turn', name, look: state === 'you' ? 'you' : 'running', from, to: now, open: true },
    ]
  }
  const ms = outputs?.turnMs ?? 0
  return [
    {
      key: 'turn',
      name,
      look: state === 'stopped' ? 'error' : 'done',
      from: updatedAt - ms,
      to: updatedAt,
      open: false,
    },
  ]
}
