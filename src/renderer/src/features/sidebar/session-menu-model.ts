import type { KeyboardEvent } from 'react'
import type { BaseUIEvent } from '@base-ui/react/types'
import { isDefaultAgent } from '@shared/agents'
import type { SessionSummary } from '@shared/agent-host'

export type SessionMenuItem =
  | 'stop'
  | 'retry'
  | 'open'
  | 'pin'
  | 'unread'
  | 'rename'
  | 'fork'
  | 'newSubSession'
  | 'openInSplit'
  | 'pullRequest'
  | 'openInEditor'
  | 'showInFolder'
  | 'openTerminal'
  | 'copyResume'
  | 'copySessionId'
  | 'showInParent'
  | 'archive'
  | 'delete'

/**
 * Where the menu opens: the row's context menu, or the top bar's More menu, which leaves out what
 * the sidebar row is for and adds what the session in front needs.
 */
export type SessionMenuPlace = 'row' | 'more'

/**
 * The keys that run an item while the menu is open, in `formatShortcut`'s notation: a letter
 * alone, or a key with modifiers.
 */
export const ACCELERATORS: Partial<Record<SessionMenuItem, string>> = {
  stop: 'Mod+.',
  retry: 'T',
  pin: 'P',
  unread: 'U',
  rename: 'R',
  fork: 'F',
  showInFolder: 'Alt+Mod+R',
  openTerminal: 'Ctrl+`',
  archive: 'A',
  delete: 'Backspace',
}

/** Open in split view's sides, which take their keys while its submenu is open. */
export const SPLIT_ACCELERATORS = { right: 'Mod+\\', below: 'Shift+Mod+\\' } as const

/** The Delete item's second key, which deletes at once when there is nothing to lose. */
export const QUICK_DELETE = 'Mod+Backspace'

export function isRunning(summary: Pick<SessionSummary, 'status'>): boolean {
  return summary.status === 'running' || summary.status === 'awaiting_permission'
}

/**
 * The groups a session's menu shows, by its state, with no empty group. A session a pane already
 * shows has no **Open in split view**, which only opens one the split does not hold.
 */
export function sessionMenuGroups(
  summary: Pick<SessionSummary, 'status' | 'parentId' | 'origin' | 'pr'>,
  canFork: boolean,
  shown = false,
  place: SessionMenuPlace = 'row',
): SessionMenuItem[][] {
  const running = isRunning(summary)
  // Its parent archives and deletes a subagent, so its menu opens it, stops it or finds it.
  if (summary.origin === 'subagent') {
    return [running ? ['open', 'stop'] : ['open'], summary.parentId ? ['showInParent'] : []].filter(
      (group) => group.length > 0,
    ) as SessionMenuItem[][]
  }
  const topLevel = summary.parentId === null
  const { status } = summary
  const state: SessionMenuItem[] = running
    ? ['stop']
    : status === 'failed' || status === 'auth_required'
      ? ['retry']
      : []
  const groups: SessionMenuItem[][] =
    place === 'more'
      ? [
          state,
          [
            'rename',
            ...(topLevel ? (['pin'] as const) : []),
            ...(topLevel && canFork ? (['fork'] as const) : []),
          ],
          ['openInEditor', 'showInFolder', 'openTerminal'],
          ['copyResume', 'copySessionId'],
          topLevel ? ['archive', 'delete'] : ['delete'],
        ]
      : [
          state,
          topLevel ? ['pin', 'unread', 'rename'] : ['unread', 'rename'],
          topLevel && canFork ? ['fork', 'newSubSession'] : ['newSubSession'],
          [
            ...(shown ? [] : (['openInSplit'] as const)),
            ...(summary.pr ? (['pullRequest'] as const) : []),
            'copyResume',
            'showInFolder',
          ],
          topLevel ? ['archive', 'delete'] : ['delete'],
        ]
  return groups.filter((group) => group.length > 0)
}

export type MultiSessionMenuItem =
  'stop' | 'read' | 'unread' | 'pin' | 'unpin' | 'archive' | 'delete'

export const MULTI_ACCELERATORS: Partial<Record<MultiSessionMenuItem, string>> = {
  stop: 'Mod+.',
  archive: 'A',
  delete: 'Backspace',
}

/**
 * The menu for several sessions at once: only what applies to every one of them, so an item never
 * does something to a part of the selection and skips the rest.
 */
export function multiSessionMenuGroups(
  summaries: readonly Pick<
    SessionSummary,
    'status' | 'parentId' | 'origin' | 'attention' | 'pinnedAt'
  >[],
  inFront: (index: number) => boolean = () => false,
): MultiSessionMenuItem[][] {
  const every = (test: (s: (typeof summaries)[number], index: number) => boolean) =>
    summaries.length > 0 && summaries.every(test)
  const own = every((s) => s.origin !== 'subagent')
  const topLevel = own && every((s) => s.parentId === null)
  const running = every(isRunning)
  const reading: MultiSessionMenuItem[] = every((s) => s.attention === 'unread')
    ? ['read']
    : every((s, index) => s.attention !== 'unread' && !inFront(index))
      ? ['unread']
      : []
  const pinning: MultiSessionMenuItem[] = !topLevel
    ? []
    : every((s) => s.pinnedAt !== null)
      ? ['unpin']
      : every((s) => s.pinnedAt === null)
        ? ['pin']
        : []
  const groups: MultiSessionMenuItem[][] = [
    running ? ['stop'] : [],
    own ? [...reading, ...pinning] : [],
    [
      ...(topLevel ? (['archive'] as const) : []),
      ...(own && every((s) => !isRunning(s)) ? (['delete'] as const) : []),
    ],
  ]
  return groups.filter((group) => group.length > 0)
}

/**
 * The command that resumes the session in its harness's own CLI, run from its folder; null for a
 * harness without one, or an added agent, whose CLI reads another config folder.
 */
export function resumeCommand(
  summary: Pick<SessionSummary, 'agentId' | 'projectPath' | 'acpSessionId'>,
  windows: boolean,
): string | null {
  const id = summary.acpSessionId
  if (!id || !isDefaultAgent(summary.agentId)) return null
  const quote = windows ? quoteWindows : quotePosix
  const cd = `cd ${quote(summary.projectPath)} && `
  switch (summary.agentId) {
    case 'claude-code':
      return `${cd}claude --resume ${quote(id)}`
    case 'codex':
      return `${cd}codex resume ${quote(id)}`
    default:
      return null
  }
}

function quotePosix(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

function quoteWindows(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

/** Whether a key press is the shortcut, written in `formatShortcut`'s notation. */
export function matchesShortcut(
  event: Pick<
    globalThis.KeyboardEvent,
    'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
  shortcut: string,
  mac: boolean,
): boolean {
  const parts = shortcut.split('+')
  // A lone "+" key would split into empty parts; no accelerator uses it.
  const key = parts.pop()!
  const want = new Set(parts)
  const mod = want.has('Mod')
  const ctrl = want.has('Ctrl') || (mod && !mac)
  const meta = mod && mac
  if (event.metaKey !== meta || event.ctrlKey !== ctrl) return false
  if (event.altKey !== want.has('Alt') || event.shiftKey !== want.has('Shift')) return false
  switch (key) {
    case '.':
      return event.code === 'Period' || event.key === '.'
    case '`':
      return event.code === 'Backquote'
    case '\\':
      return event.code === 'Backslash'
    case 'Backspace':
      return event.key === 'Backspace' || event.key === 'Delete'
    default:
      // With Alt held a letter's `key` is another character on macOS; the physical key decides.
      return event.code === `Key${key.toUpperCase()}` || event.key.toUpperCase() === key
  }
}

/**
 * Runs the item whose accelerator was pressed, in place of the menu's first-letter typeahead. Keys
 * pressed in a submenu reach this through React's tree but belong to the submenu. The Delete item's
 * second key clicks it with the main modifier held, which its handler reads.
 */
export function runSessionMenuAccelerator(
  event: BaseUIEvent<KeyboardEvent<HTMLElement>>,
  mac: boolean,
): void {
  if (!event.currentTarget.contains(event.target as Node)) return
  const letter = /^[a-z]$/i.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey
  if (letter) event.preventBaseUIHandler()
  const items = event.currentTarget.querySelectorAll<HTMLElement>(
    '[data-accelerator]:not([data-disabled])',
  )
  for (const item of items) {
    const quick = item.dataset.quickAccelerator
    if (quick && matchesShortcut(event.nativeEvent, quick, mac)) {
      event.preventDefault()
      event.preventBaseUIHandler()
      item.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac }),
      )
      return
    }
    if (matchesShortcut(event.nativeEvent, item.dataset.accelerator!, mac)) {
      event.preventDefault()
      event.preventBaseUIHandler()
      item.click()
      return
    }
  }
}
