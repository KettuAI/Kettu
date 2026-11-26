import type { SessionSummary } from '@shared/agent-host'
import type { PendingRequest } from '@shared/pending-requests'
import { diffPathOf, toolContentItems, type ThreadEntry, type ToolEntry } from '@shared/thread'

/** A request the panel shows; the cards it has no words for are answered in the window. */
export type TrayRequest = Exclude<PendingRequest, { kind: 'other' }>

export function trayRequest(request: PendingRequest): request is TrayRequest {
  return request.kind !== 'other'
}

/** What the panel reads of a session: its requests while it waits, its changed files once done. */
export interface SessionDetail {
  /**
   * The summary's `updatedAt` and `permissionCount` it was read at, to read it again once either
   * moves: a request settling moves the count alone.
   */
  readAt: number
  readRequests: number
  requests: TrayRequest[]
  /** Files the last turn changed; null until read. */
  files: number | null
}

/** Whether a session moved on since it was read. */
export function stale(summary: SessionSummary, detail: SessionDetail | undefined): boolean {
  return detail?.readAt !== summary.updatedAt || detail.readRequests !== summary.permissionCount
}

const FILE_KINDS = new Set<ToolEntry['toolKind']>(['edit', 'delete', 'move'])

/** The files the last turn of a thread's latest page changed. */
export function changedFiles(entries: readonly ThreadEntry[]): number {
  // The last turn starts at the last message the user sent.
  let turn = 0
  entries.forEach((entry, i) => {
    if (entry.kind === 'user') turn = i
  })
  const files = new Set<string>()
  entries.forEach((entry, i) => {
    if (entry.kind !== 'tool' || i < turn || entry.status !== 'completed') return
    if (!FILE_KINDS.has(entry.toolKind)) return
    for (const location of entry.locations) files.add(location.path)
    for (const content of toolContentItems(entry)) {
      const path = diffPathOf(content)
      if (path !== null) files.add(path)
    }
  })
  return files.size
}
