import type { TFunction } from 'i18next'
import { isActivelyRunning, type Project, type SessionSummary } from '@shared/agent-host'
import { projectNameHints } from '@renderer/features/session/project-names'
import { hostPath } from '@renderer/lib/host-paths'
import {
  activeProjects,
  findProjectForSession,
  isSessionInArchivedProject,
} from '@renderer/stores/projects'
import { hostOfSession, liveTree, type SessionNode } from '@renderer/stores/sessions'
import { rowStatus, type RowStatus } from './row-status'

/**
 * Activity priority buckets for the sidebar Activity view:
 * - `waiting`: sessions awaiting user approval or input (always pinned to the top)
 * - `running`: sessions actively running a turn or starting up
 * - `background`: sessions idle between turns with background commands, sub-agents, monitors, or schedules
 */
export type ActivityBucket = 'waiting' | 'running' | 'background'

const BUCKET_RANK: Record<ActivityBucket, number> = {
  waiting: 0,
  running: 1,
  background: 2,
}

export interface ActivitySession {
  node: SessionNode
  bucket: ActivityBucket
  status: RowStatus
  hostId: string | null
  /** Display name for the owning project (with disambiguating hint if duplicated), or null for No project. */
  projectName: string | null
  /** Most recent update timestamp across the session and its active sub-sessions. */
  updatedAt: number
}

export interface ActivityCounts {
  waiting: number
  running: number
  background: number
  total: number
}

function hasWaitingSummary(summary: SessionSummary): boolean {
  return (
    summary.permissionCount > 0 ||
    summary.attention === 'permission' ||
    summary.status === 'awaiting_permission'
  )
}

function hasRunningSubagent(node: SessionNode): boolean {
  if (
    node.subagents.some(
      (agent) => !agent.archivedAt && (isActivelyRunning(agent) || agent.status === 'starting'),
    )
  ) {
    return true
  }
  return node.children.some((child) => !child.summary.archivedAt && hasRunningSubagent(child))
}

function activeUpdatedAt(node: SessionNode): number {
  let latest = node.summary.updatedAt
  for (const child of node.children) {
    if (child.summary.archivedAt != null) continue
    if (child.summary.updatedAt > latest) latest = child.summary.updatedAt
  }
  return latest
}

function pathLeafName(path: string): string | null {
  const clean = hostPath(path).replace(/[\\/]+$/, '')
  if (!clean) return null
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return slash >= 0 ? clean.slice(slash + 1) || null : clean
}

function resolveProjectName(
  summary: SessionSummary,
  projects: readonly Project[],
  hints: ReadonlyMap<string, string>,
): string | null {
  if (summary.scratch) return null
  const project = findProjectForSession(projects, summary)
  if (!project) return pathLeafName(summary.projectPath)
  const hint = hints.get(project.path)
  return hint ? `${project.name} · ${hint}` : project.name
}

/**
 * Classifies a top-level session tree node for the Activity view using `rowStatus(node, true)`.
 * Returns null for idle or archived sessions so only active or attention-needing sessions appear.
 */
export function classifyActivityNode(
  node: SessionNode,
): { bucket: ActivityBucket; status: RowStatus } | null {
  if (node.summary.archivedAt != null) return null
  const status = rowStatus(node, true)
  const waitingChild = node.children.some(
    (child) => child.summary.archivedAt == null && hasWaitingSummary(child.summary),
  )
  if (status.waiting > 0 || hasWaitingSummary(node.summary) || waitingChild) {
    return { bucket: 'waiting', status }
  }
  const startingChild = node.children.some(
    (child) => child.summary.archivedAt == null && child.summary.status === 'starting',
  )
  if (status.running || status.starting || startingChild) {
    return { bucket: 'running', status }
  }
  if (status.background !== null || hasRunningSubagent(node)) {
    return { bucket: 'background', status }
  }
  return null
}

/**
 * Selects and sorts non-archived active sessions across this computer and connected remote hosts:
 * waiting for approval/reply first, then running/starting, then background tasks, newest first within each tier.
 */
export function activitySessions(
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
  options?: {
    hosts?: readonly (string | null)[] | null
    away?: readonly string[]
  },
): ActivitySession[] {
  const hosts = options?.hosts ?? null
  const away = options?.away ?? []
  const visible = activeProjects(projects)
  const hints = projectNameHints(visible)
  const items: ActivitySession[] = []

  for (const node of liveTree(byId)) {
    const hostId = hostOfSession(node.summary)
    if (hosts ? !hosts.includes(hostId) : hostId !== null) continue
    if (hostId !== null && away.includes(hostId)) continue
    if (isSessionInArchivedProject(node.summary, projects)) continue

    const classified = classifyActivityNode(node)
    if (!classified) continue

    items.push({
      node,
      bucket: classified.bucket,
      status: classified.status,
      hostId,
      projectName: resolveProjectName(node.summary, projects, hints),
      updatedAt: activeUpdatedAt(node),
    })
  }

  return items.sort(
    (a, b) =>
      BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
      b.updatedAt - a.updatedAt ||
      (a.node.summary.id < b.node.summary.id ? -1 : a.node.summary.id > b.node.summary.id ? 1 : 0),
  )
}

/** Counts activity sessions per bucket and overall. */
export function countActivitySessions(
  items: readonly Pick<ActivitySession, 'bucket'>[],
): ActivityCounts {
  let waiting = 0
  let running = 0
  let background = 0
  for (const item of items) {
    if (item.bucket === 'waiting') waiting++
    else if (item.bucket === 'running') running++
    else background++
  }
  return { waiting, running, background, total: waiting + running + background }
}

/** Strongest indicator tone for the sidebar Activity button dot, or null when idle. */
export function activityButtonTone(counts: ActivityCounts): ActivityBucket | null {
  if (counts.waiting > 0) return 'waiting'
  if (counts.running > 0) return 'running'
  if (counts.background > 0) return 'background'
  return null
}

/** Formats the secondary project / host context line shown under an Activity view session row. */
export function activityContextText(
  item: Pick<ActivitySession, 'projectName'>,
  options: {
    noProjectLabel: string
    hostName?: string | null
    showHost: boolean
    separator: string
  },
): string {
  const project = item.projectName ?? options.noProjectLabel
  if (options.showHost && options.hostName) {
    return `${project}${options.separator}${options.hostName}`
  }
  return project
}

/** Concise localized summary of active sessions for the Activity button tooltip and description. */
export function activitySummaryText(
  t: TFunction<'sidebar'>,
  counts: ActivityCounts,
): string | null {
  const parts: string[] = []
  if (counts.waiting > 0) parts.push(t('activity.waitingCount', { count: counts.waiting }))
  if (counts.running > 0) parts.push(t('activity.runningCount', { count: counts.running }))
  if (counts.background > 0) parts.push(t('activity.backgroundCount', { count: counts.background }))
  return parts.length > 0 ? parts.join(t('activity.separator')) : null
}

/** Accessible label combining the localized Search action name with the platform shortcut. */
export function searchButtonLabel(searchLabel: string, shortcut: string): string {
  return shortcut ? `${searchLabel} ${shortcut}` : searchLabel
}
