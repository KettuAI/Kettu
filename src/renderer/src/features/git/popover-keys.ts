import type { KeyboardEvent, PointerEvent } from 'react'
import type { GitStatus } from '@shared/git'
import { isMod } from '@renderer/lib/platform'

/** The branch as the popover names it: the short id when detached. */
export function branchName(status: GitStatus): string {
  const { head } = status
  return head.detached ? (head.oid?.slice(0, 7) ?? 'HEAD') : (head.branch ?? 'HEAD')
}

const MOVES = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End'])

/**
 * The popover's keys: Up, Down, Home and End move through its rows wherever focus is in it, and
 * `Mod+C` off a commit copies the branch name. Rows handle their own Right, Left and Enter.
 */
export function popoverKeys(event: KeyboardEvent<HTMLElement>, branch: string): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return
  if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
    if (window.getSelection()?.toString()) return
    event.preventDefault()
    void navigator.clipboard.writeText(branch)
    return
  }
  if (!MOVES.has(event.key)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-git-row]'))
  if (rows.length === 0) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const down = event.key === 'ArrowDown'
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : at < 0
          ? down
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)))
  const row = rows[next]
  row?.focus({ preventScroll: true })
  row?.scrollIntoView({ block: 'nearest' })
}

/**
 * Moves focus to the row under a moving pointer, so hover and the arrow keys highlight one row.
 * Only a move counts: a row that slides under a resting pointer keeps the keyboard's focus.
 */
export function followPointer(event: PointerEvent<HTMLElement>): void {
  if (event.pointerType === 'touch') return
  const row = (event.target as Element).closest<HTMLElement>(
    '[data-git-row]:not([data-slot=button])',
  )
  if (row && row !== document.activeElement) row.focus({ preventScroll: true })
}

/** Right unfolds a row that opens in place, Left folds it. */
export function disclosureKeys(open: boolean, toggle: () => void) {
  return (event: KeyboardEvent) => {
    if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) {
      event.preventDefault()
      toggle()
    }
  }
}

/** Left on a row inside an expanded one goes back to the row that holds it. */
export function kidKeys(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowLeft') return
  const holder = event.currentTarget.closest('[data-git-kids]')?.previousElementSibling
  const row = holder?.matches('[data-git-row]')
    ? holder
    : holder?.querySelector<HTMLElement>('[data-git-row]')
  if (row instanceof HTMLElement) {
    event.preventDefault()
    row.focus()
  }
}
