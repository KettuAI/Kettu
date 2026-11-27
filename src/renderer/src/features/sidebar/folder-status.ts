import type { TFunction } from 'i18next'
import { isActivelyRunning } from '@shared/agent-host'
import type { TaskSummary } from '@shared/workflow'
import type { SessionNode } from '@renderer/stores/sessions'
import type { RowStatus } from './row-status'

export type FolderIndicatorKind = 'waiting' | 'failed' | 'running' | 'starting' | 'unread'

export interface FolderStatusCounts {
  waiting: number
  failed: number
  running: number
  starting: number
  unread: number
}

export interface FolderStatus {
  /** Highest-priority status represented by the collapsed folder indicator. */
  kind: FolderIndicatorKind
  /** Non-archived session and task counts hidden inside the folder, bucketed by highest priority. */
  counts: FolderStatusCounts
  /** RowStatus projection for rendering with SessionIndicator. */
  row: RowStatus
}

const PRIORITY: readonly FolderIndicatorKind[] = [
  'waiting',
  'failed',
  'running',
  'starting',
  'unread',
]

function classifySession(node: SessionNode): FolderIndicatorKind | null {
  const { summary } = node
  if (summary.archivedAt != null) return null
  if (
    node.own.permissionCount > 0 ||
    summary.attention === 'permission' ||
    summary.status === 'awaiting_permission'
  ) {
    return 'waiting'
  }
  if (summary.attention === 'error' || summary.status === 'failed') {
    return 'failed'
  }
  if (isActivelyRunning(summary)) {
    return 'running'
  }
  if (summary.status === 'starting') {
    return 'starting'
  }
  if (summary.attention === 'unread') {
    return 'unread'
  }
  return null
}

function classifyTask(task: TaskSummary): FolderIndicatorKind | null {
  if (task.archivedAt != null) return null
  const live = task.status === 'running'
  if (live && task.needsYou && !task.error) return 'waiting'
  if (live && task.error) return 'failed'
  if (live && task.running) return 'running'
  if (task.unread) return 'unread'
  return null
}

/**
 * Aggregated status for a project folder header. Returns null while the folder is expanded, while
 * its host is unreachable, or when no hidden session or task needs attention or is actively running.
 */
export function collapsedFolderStatus(
  nodes: readonly SessionNode[],
  {
    collapsed,
    away = false,
    tasks = [],
  }: {
    collapsed: boolean
    away?: boolean
    tasks?: readonly TaskSummary[]
  },
): FolderStatus | null {
  if (!collapsed || away) return null

  const counts: FolderStatusCounts = {
    waiting: 0,
    failed: 0,
    running: 0,
    starting: 0,
    unread: 0,
  }

  const walk = (list: readonly SessionNode[]) => {
    for (const node of list) {
      if (node.summary.archivedAt != null) continue
      const kind = classifySession(node)
      if (kind) counts[kind]++
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)

  for (const task of tasks) {
    const kind = classifyTask(task)
    if (kind) counts[kind]++
  }

  const kind = PRIORITY.find((item) => counts[item] > 0)
  if (!kind) return null

  return {
    kind,
    counts,
    row: {
      waiting: counts.waiting,
      failed: counts.failed > 0,
      running: counts.running > 0,
      background: null,
      starting: counts.starting > 0,
      unread: counts.unread > 0,
    },
  }
}

function primaryText(t: TFunction<'sidebar'>, kind: FolderIndicatorKind, count: number): string {
  switch (kind) {
    case 'waiting':
      return t('folderStatus.waiting', { count })
    case 'failed':
      return t('folderStatus.failed', { count })
    case 'running':
      return t('folderStatus.running', { count })
    case 'starting':
      return t('folderStatus.starting', { count })
    case 'unread':
      return t('folderStatus.unread', { count })
  }
}

function shortText(t: TFunction<'sidebar'>, kind: FolderIndicatorKind, count: number): string {
  switch (kind) {
    case 'waiting':
      return t('folderStatus.short.waiting', { count })
    case 'failed':
      return t('folderStatus.short.failed', { count })
    case 'running':
      return t('folderStatus.short.running', { count })
    case 'starting':
      return t('folderStatus.short.starting', { count })
    case 'unread':
      return t('folderStatus.short.unread', { count })
  }
}

/**
 * Concise localized summary for the collapsed folder tooltip and indicator aria-label, ordered by
 * status priority.
 */
export function folderStatusText(t: TFunction<'sidebar'>, counts: FolderStatusCounts): string {
  const parts: string[] = []
  for (const kind of PRIORITY) {
    const count = counts[kind]
    if (count <= 0) continue
    parts.push(parts.length === 0 ? primaryText(t, kind, count) : shortText(t, kind, count))
  }
  return parts.join(t('folderStatus.separator'))
}
