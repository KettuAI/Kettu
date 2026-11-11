import { GitForkIcon } from '@hugeicons/core-free-icons'

/** The mark of a session that works in a worktree of its own, wherever it is shown. */
export const WORKTREE_ICON = GitForkIcon

/** The first characters of a commit, as git shows them. */
export function shortOid(oid: string): string {
  return oid.slice(0, 7)
}
