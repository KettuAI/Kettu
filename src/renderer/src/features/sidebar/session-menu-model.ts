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
  | 'forkSame'
  | 'newSubSession'
  | 'openInSplit'
  | 'pullRequest'
  | 'openInEditor'
  | 'showInFolder'
  | 'openTerminal'
  | 'copyResume'
  | 'copySessionId'
  | 'showInParent'
  | 'removeWorktree'
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

/** What the session can do where its menu opens. */
export interface SessionMenuContext {
  canFork: boolean
  /** A pane shows the session already. */
  shown?: boolean
  place?: SessionMenuPlace
  /** Its folder is on this computer, which its file manager and editors open. */
  local: boolean
  /** The terminal may open in its folder. */
  terminal: boolean
  /** Its harness has a command that resumes it. */
  resume: boolean
  /** The menu's place has a title field to rename it in; true when left out. */
  rename?: boolean
  /** It works in a worktree Kettu made that a fork can share. */
  worktree?: boolean
  /** Its worktree can be removed now. */
  removeWorktree?: boolean
}

/**
 * The groups a session's menu shows, by its state and where it opens, with no empty group. A
 * session a pane already shows has no **Open in split view**, which only opens one the split does
 * not hold.
 */
export function sessionMenuGroups(
  summary: Pick<SessionSummary, 'status' | 'parentId' | 'origin' | 'pr' | 'prs'>,
  {
    canFork,
    shown = false,
    place = 'row',
    local,
    terminal,
    resume,
    rename = true,
    worktree = false,
    removeWorktree = false,
  }: SessionMenuContext,
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
  const forks: SessionMenuItem[] =
    topLevel && canFork ? (worktree ? ['fork', 'forkSame'] : ['fork']) : []
  const ending: SessionMenuItem[] = [
    ...(removeWorktree ? (['removeWorktree'] as const) : []),
    ...(topLevel ? (['archive'] as const) : []),
    'delete',
  ]
  const state: SessionMenuItem[] = running
    ? ['stop']
    : status === 'failed' || status === 'auth_required'
      ? ['retry']
      : []
  const groups: SessionMenuItem[][] =
    place === 'more'
      ? [
          state,
          ['rename', ...(topLevel ? (['pin'] as const) : []), ...forks],
          ['openInEditor', 'showInFolder', 'openTerminal'],
          ['copyResume', 'copySessionId'],
          ending,
        ]
      : [
          state,
          topLevel ? ['pin', 'unread', 'rename'] : ['unread', 'rename'],
          [...forks, 'newSubSession'],
          [
            ...(shown ? [] : (['openInSplit'] as const)),
            ...((summary.prs?.length ?? (summary.pr ? 1 : 0)) > 0
              ? (['pullRequest'] as const)
              : []),
            'copyResume',
            'showInFolder',
          ],
          ending,
        ]
  const missing = new Set<SessionMenuItem>([
    ...(local ? [] : (['openInEditor', 'showInFolder'] as const)),
    ...(terminal ? [] : (['openTerminal'] as const)),
    ...(resume ? [] : (['copyResume'] as const)),
    ...(rename ? [] : (['rename'] as const)),
  ])
  return groups
    .map((group) => group.filter((item) => !missing.has(item)))
    .filter((group) => group.length > 0)
}

export type MultiSessionMenuItem =
  'stop' | 'read' | 'unread' | 'pin' | 'unpin' | 'archive' | 'delete'

export const MULTI_ACCELERATORS: Partial<Record<MultiSessionMenuItem, string>> = {
  stop: 'Mod+.',
  archive: 'A',
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

/** Runs one call per id, all at once: the ids that went through, and the errors of the rest. */
export async function settle(
  ids: readonly string[],
  run: (id: string) => Promise<unknown>,
): Promise<{ done: string[]; errors: unknown[] }> {
  const results = await Promise.allSettled(ids.map(async (id) => run(id)))
  const done: string[] = []
  const errors: unknown[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') done.push(ids[index]!)
    else errors.push(result.reason)
  })
  return { done, errors }
}

/**
 * Whether the Delete item's second key deletes at once: no sub-session goes with them and their
 * folders hold no uncommitted file. A folder the host could not read (null) is not known to hold
 * none.
 */
export function canDeleteAtOnce(files: readonly (number | null)[], withChildren: boolean): boolean {
  return !withChildren && files.every((count) => count === 0)
}

/**
 * The command that resumes the session in its harness's own CLI, run from its folder as its host
 * writes it, quoted for that host's shell by the path's form; null for a harness without one, or
 * an added agent, whose CLI reads another config folder.
 */
export function resumeCommand(
  summary: Pick<SessionSummary, 'agentId' | 'acpSessionId'>,
  folder: string,
): string | null {
  const id = summary.acpSessionId
  if (!id || !isDefaultAgent(summary.agentId)) return null
  const windows = /^[a-z]:[\\/]/i.test(folder) || folder.startsWith('\\\\')
  const quote = windows ? quoteWindows : quotePosix
  // cmd's cd keeps the shell's drive and refuses a network path; pushd does neither.
  const cd = `${windows ? 'pushd' : 'cd'} ${quote(folder)} && `
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
      // A letter is the one the layout types. Where `key` is another character, as with Alt held
      // on macOS or on a layout without Latin letters, the physical key decides.
      if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase() === key
      return event.code === `Key${key.toUpperCase()}`
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
