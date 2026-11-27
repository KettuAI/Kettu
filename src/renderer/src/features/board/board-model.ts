import type { TFunction } from 'i18next'
import type { SessionSummary } from '@shared/agent-host'
import { subagentRunning } from '@shared/session-groups'
import type { BackgroundTaskView, ThreadState } from '@shared/thread'
import { labelText, toolLabel } from '@renderer/features/session/entries/helpers'
import { ansiRuns } from '@renderer/features/session/entries/shell'
import type { SubagentDigest, SubagentStep } from '@renderer/features/session/subagent/progress'
import { listedSubagents } from '@renderer/features/sidebar/subagents'

export interface BoardActivity {
  /** Background tasks, sub-agents and child sessions at work. */
  running: number
  /** Sub-agents and child sessions waiting for the user's answer. */
  needs: number
}

/**
 * Whether a session belongs to `parentId`'s board: its unarchived sub-agents and child sessions
 * (such as those started through `start_session`), excluding prepared drafts.
 */
export function isBoardChild(
  child: Pick<SessionSummary, 'parentId' | 'origin' | 'archivedAt' | 'prepared'>,
  parentId: string,
): boolean {
  return (
    child.parentId === parentId &&
    (child.origin === 'subagent' || child.origin === 'user') &&
    child.archivedAt === null &&
    !child.prepared
  )
}

/** Unarchived sub-agents and child sessions under `parentId`, deduplicated by id. */
export function boardChildren(
  byId: Readonly<Record<string, SessionSummary>>,
  parentId: string,
): SessionSummary[] {
  const seen = new Set<string>()
  const out: SessionSummary[] = []
  for (const child of Object.values(byId)) {
    if (!isBoardChild(child, parentId) || seen.has(child.id)) continue
    seen.add(child.id)
    out.push(child)
  }
  return out
}

/** Running and waiting counts across `parentId`'s board children. */
export function boardChildActivity(
  byId: Readonly<Record<string, SessionSummary>>,
  parentId: string,
): BoardActivity {
  let running = 0
  let needs = 0
  for (const child of boardChildren(byId, parentId)) {
    if (subagentWaiting(child)) needs++
    else if (subagentRunning(child)) running++
  }
  return { running, needs }
}

/**
 * Live keys for `parentId`'s board children, for the board button's unread dot. A child that starts
 * waiting for the user is news again, so its state is part of its key.
 */
export function boardChildKeys(
  byId: Readonly<Record<string, SessionSummary>>,
  parentId: string,
): string[] {
  const keys: string[] = []
  for (const child of boardChildren(byId, parentId)) {
    if (subagentWaiting(child)) keys.push(`agent:${child.id}:needs`)
    else if (subagentRunning(child)) keys.push(`agent:${child.id}:running`)
  }
  return keys
}

/** Running tasks first, the latest started first, then the ended ones, the latest ended first. */
export function backgroundOrder(tasks: readonly BackgroundTaskView[]): BackgroundTaskView[] {
  const running = tasks.filter((task) => task.status === 'running')
  const ended = tasks.filter((task) => task.status !== 'running')
  return [
    ...running.sort((a, b) => b.startedAt - a.startedAt),
    ...ended.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
  ]
}

export function subagentWaiting(child: Pick<SessionSummary, 'status'>): boolean {
  return child.status === 'awaiting_permission'
}

export function subagentFailed(child: Pick<SessionSummary, 'status' | 'attention'>): boolean {
  return child.status === 'failed' || child.attention === 'error'
}

/** The sub-agents and child sessions the way the board lists them: those waiting for the user, then the rest. */
export function boardSubagents(children: readonly SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>()
  const unique = children.filter((child) => {
    if (seen.has(child.id)) return false
    seen.add(child.id)
    return true
  })
  const listed = listedSubagents(unique, true)
  return [...listed.filter(subagentWaiting), ...listed.filter((child) => !subagentWaiting(child))]
}

/** The last line a command printed that says something; a progress bar's last redraw counts. */
export function lastLine(output: string): string | null {
  const plain = ansiRuns(output)
    .map((run) => run.text)
    .join('')
  const lines = plain.split(/\r\n|\r|\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line) return line
  }
  return null
}

/** How an ended task finished in a few words: the exit code its agent reported, else why it failed. */
export function endedNote(task: BackgroundTaskView, t: TFunction<'board'>): string | null {
  if (task.status === 'running') return null
  const code = /\(exit code (-?\d+)\)/.exec(task.summary ?? '')?.[1]
  if (code !== undefined) return t('detail.exit', { code })
  return task.status === 'failed' ? task.summary : null
}

function stepText(
  step: Pick<SubagentStep, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  projectPath: string,
) {
  return labelText(toolLabel(step, projectPath))
}

/** What a sub-agent is doing now: its call in flight, else null. */
export function currentStep(digest: SubagentDigest | null, projectPath: string): string | null {
  const step = digest?.steps.findLast((s) => s.status === 'in_progress' || s.status === 'pending')
  return step ? stepText(step, projectPath) : null
}

/** What a waiting sub-agent asks to do, else null. */
export function askedStep(digest: SubagentDigest | null, projectPath: string): string | null {
  const step = digest?.steps.find((s) => s.waiting)
  return step ? stepText(step, projectPath) : null
}

/** An artifact the thread wrote, by the thread's last entry about it. */
export interface BoardArtifact {
  entryId: string
  artifactId: string
}

// Read once per order: an entry's kind, action and artifact never change after it is added.
const written = new WeakMap<readonly string[], BoardArtifact[]>()

/** The artifacts the thread wrote and did not delete, the latest written first. */
export function threadArtifacts({
  order,
  byId,
}: Pick<ThreadState, 'order' | 'byId'>): BoardArtifact[] {
  const cached = written.get(order)
  if (cached) return cached
  const last = new Map<string, { entryId: string; deleted: boolean }>()
  for (const id of order) {
    const entry = byId[id]
    if (entry?.kind !== 'artifact') continue
    // Deleting first moves the artifact to the end of the map's order.
    last.delete(entry.artifactId)
    last.set(entry.artifactId, { entryId: entry.id, deleted: entry.action === 'delete' })
  }
  const artifacts = [...last]
    .filter(([, entry]) => !entry.deleted)
    .map(([artifactId, entry]) => ({ entryId: entry.entryId, artifactId }))
    .reverse()
  written.set(order, artifacts)
  return artifacts
}

/** The counts in words, each null when zero: "3 running" and "1 needs you". */
export function summaryParts(
  t: TFunction<'board'>,
  { running, needs }: BoardActivity,
): { running: string | null; needs: string | null } {
  return {
    running: running > 0 ? t('summary.running', { count: running }) : null,
    needs: needs > 0 ? t('summary.needs', { count: needs }) : null,
  }
}
