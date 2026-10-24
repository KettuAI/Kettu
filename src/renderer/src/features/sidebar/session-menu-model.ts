import type { KeyboardEvent } from 'react'
import type { BaseUIEvent } from '@base-ui/react/types'
import type { SessionSummary } from '@shared/agent-host'

export type SessionMenuItem =
  | 'stop'
  | 'retry'
  | 'pin'
  | 'unread'
  | 'rename'
  | 'fork'
  | 'newSubSession'
  | 'pullRequest'
  | 'showInFolder'
  | 'archive'
  | 'delete'

/** The one-key accelerators that run an item while the menu is open. */
export const ACCELERATORS: Partial<Record<SessionMenuItem, string>> = {
  stop: 'S',
  retry: 'T',
  pin: 'P',
  unread: 'U',
  rename: 'R',
  fork: 'F',
  pullRequest: 'G',
  showInFolder: 'O',
  archive: 'A',
  delete: 'D',
}

/** The groups a session's menu shows, by its state, with no empty group. */
export function sessionMenuGroups(
  summary: Pick<SessionSummary, 'status' | 'parentId' | 'origin' | 'pr'>,
  canFork: boolean,
): SessionMenuItem[][] {
  // Its parent stops, archives and deletes a subagent, and its own bar has Stop.
  if (summary.origin === 'subagent') return [['unread', 'rename']]
  const topLevel = summary.parentId === null
  const { status } = summary
  const groups: SessionMenuItem[][] = [
    status === 'running' || status === 'awaiting_permission'
      ? ['stop']
      : status === 'failed' || status === 'auth_required'
        ? ['retry']
        : [],
    topLevel ? ['pin', 'unread', 'rename'] : ['unread', 'rename'],
    topLevel && canFork ? ['fork', 'newSubSession'] : ['newSubSession'],
    summary.pr ? ['pullRequest', 'showInFolder'] : ['showInFolder'],
    topLevel ? ['archive'] : [],
    ['delete'],
  ]
  return groups.filter((group) => group.length > 0)
}

/**
 * Runs the item whose accelerator was pressed, in place of the menu's first-letter typeahead. Keys
 * pressed in a submenu reach this through React's tree but belong to the submenu.
 */
export function runSessionMenuAccelerator(event: BaseUIEvent<KeyboardEvent<HTMLElement>>): void {
  if (event.metaKey || event.ctrlKey || event.altKey || !/^[a-z]$/i.test(event.key)) return
  if (!event.currentTarget.contains(event.target as Node)) return
  event.preventBaseUIHandler()
  const item = event.currentTarget.querySelector<HTMLElement>(
    `[data-accelerator="${event.key.toUpperCase()}"]:not([data-disabled])`,
  )
  if (!item) return
  event.preventDefault()
  item.click()
}
