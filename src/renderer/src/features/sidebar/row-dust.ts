import { dissolve, inSight, type Piece } from '@renderer/lib/dust'
import { markDust, unmarkDust } from './row-exit'

/** More rows than this leave quietly: a sidebar of dust says less than a few rows of it. */
const MOST_ROWS = 6

export interface Dust {
  /** Brings back the rows of sessions that were not deleted after all. */
  restore(ids: readonly string[]): void
}

const NO_DUST: Dust = { restore: () => {} }

interface Row extends Piece {
  id: string
}

/**
 * Turns the sidebar rows of these sessions to dust, from the window's own pixels, before they are
 * deleted. Resolves once the dust has started, or at once when the rows will leave quietly
 * instead: reduced motion, the web client, too many rows, or a window that could not be read.
 */
export async function dissolveRows(ids: readonly string[]): Promise<Dust> {
  if (ids.length === 0) return NO_DUST
  const dust = await dissolve({
    find: () => rowsOf(ids),
    most: MOST_ROWS,
    within: 'aside',
    hide: (row, sweepMs) => {
      row.el.dataset.rowExit = 'dust'
      markDust([row.id], sweepMs)
    },
    what: 'the sidebar',
  })
  if (!dust) return NO_DUST
  return {
    restore: (back) => {
      for (const [i, row] of dust.pieces.entries()) {
        if (!back.includes(row.id)) continue
        dust.stop(i)
        delete row.el.dataset.rowExit
        unmarkDust([row.id])
      }
    },
  }
}

/** Each session's rows in sight in the sidebar, outermost only: a sub-session's goes with it. */
function rowsOf(ids: readonly string[]): Row[] {
  const lis = ids.flatMap((id) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        `aside [data-sidebar-row][data-session-id="${CSS.escape(id)}"]`,
      ),
    ].flatMap((button) => {
      const li = button.closest('li')
      return li ? [{ id, li }] : []
    }),
  )
  return lis.flatMap(({ id, li }) => {
    if (lis.some((other) => other.li !== li && other.li.contains(li))) return []
    const box = inSight(li, 'aside')
    return box ? [{ id, el: li, box }] : []
  })
}
