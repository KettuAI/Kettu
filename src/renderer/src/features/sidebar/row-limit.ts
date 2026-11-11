import type { SessionNode } from '@renderer/stores/sessions'

/** How many of a project's sessions show before "Show N more". */
export const ROWS_SHOWN = 5

/**
 * A group's rows: the first few, and past them any that must stay in sight, such as one waiting
 * for an answer or the one in front; every row once the group shows them all.
 */
export function limitRows<T>(
  tree: readonly T[],
  all: boolean,
  keep: (node: T) => boolean,
): { rows: T[]; hidden: number } {
  if (all || tree.length <= ROWS_SHOWN) return { rows: [...tree], hidden: 0 }
  const rows = tree.filter((node, i) => i < ROWS_SHOWN || keep(node))
  return { rows, hidden: tree.length - rows.length }
}

/** Whether a row stays in sight past the first few: it or a sub-session waits, runs or is in front. */
export function keepInSight(node: SessionNode, shownId: string | null): boolean {
  return (
    node.permissionCount > 0 ||
    node.running ||
    node.summary.id === shownId ||
    node.children.some((child) => child.summary.id === shownId)
  )
}
