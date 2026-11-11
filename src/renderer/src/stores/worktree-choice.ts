import { create } from 'zustand'

// Whether New session starts the next session of a project in a new worktree, remembered per
// project in localStorage under `worktree-choice`, with the base and branch name being picked.

const KEY = 'worktree-choice'

type Where = 'local' | 'worktree'

interface WorktreeChoiceStore {
  /** Each project's last choice; a project not listed starts Local. */
  where: Record<string, Where>
  /** The base picked for each project's next worktree; none means its current branch. */
  base: Record<string, string>
  /** The branch name the user wrote for the next worktree; null lets the host name it. */
  branch: string | null
}

function load(): Record<string, Where> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, Where] => entry[1] === 'local' || entry[1] === 'worktree',
      ),
    )
  } catch {
    return {}
  }
}

export const useWorktreeChoice = create<WorktreeChoiceStore>(() => ({
  where: load(),
  base: {},
  branch: null,
}))

export function chooseWhere(projectPath: string, where: Where): void {
  useWorktreeChoice.setState((s) => ({ where: { ...s.where, [projectPath]: where } }))
  try {
    localStorage.setItem(KEY, JSON.stringify(useWorktreeChoice.getState().where))
  } catch {
    // Kept in memory for this window.
  }
}

export function chooseBase(projectPath: string, base: string | null): void {
  useWorktreeChoice.setState((s) => {
    const next = { ...s.base }
    if (base === null) delete next[projectPath]
    else next[projectPath] = base
    return { base: next }
  })
}

export function writeBranch(branch: string | null): void {
  useWorktreeChoice.setState({ branch: branch === '' ? null : branch })
}

/** What New session asks for a project: null to work in its folder. */
export function worktreeRequest(
  projectPath: string,
  currentBranch: string | null,
): { base: string; branch?: string } | null {
  const { where, base, branch } = useWorktreeChoice.getState()
  if (where[projectPath] !== 'worktree') return null
  // Before the project's status is read, its checked-out commit: a chosen worktree never quietly
  // becomes the project's folder.
  const from = base[projectPath] ?? currentBranch ?? 'HEAD'
  return { base: from, ...(branch ? { branch } : {}) }
}
