import { create } from 'zustand'
import { branchProblem, fillBranchTemplate } from '@shared/branch-name'

// Whether New session starts the next session of a project in a new worktree, remembered per
// project in localStorage under `worktree-choice`, with the base and branch name being picked.

const KEY = 'worktree-choice'

type Where = 'local' | 'worktree'

interface WorktreeChoiceStore {
  /** Each project's last choice; a project not listed starts Local. */
  where: Record<string, Where>
  /** The base picked for each project's next worktree; none means its current branch. */
  base: Record<string, string>
  /** What the user wrote for the next worktree's `{slug}`; null lets Kettu name it. */
  slug: string | null
  /** Each project's branch template, as last read from its host. */
  template: Record<string, string>
  /** Why a project's template couldn't be read, until it is. */
  templateError: Record<string, string>
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
  slug: null,
  template: {},
  templateError: {},
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

export function writeSlug(slug: string | null): void {
  useWorktreeChoice.setState({ slug: slug === '' ? null : slug })
}

export function keepTemplate(projectPath: string, template: string): void {
  useWorktreeChoice.setState((s) => {
    const templateError = { ...s.templateError }
    delete templateError[projectPath]
    return { template: { ...s.template, [projectPath]: template }, templateError }
  })
}

export function templateFailed(projectPath: string, message: string): void {
  useWorktreeChoice.setState((s) => ({
    templateError: { ...s.templateError, [projectPath]: message },
  }))
}

/**
 * The template's text around the `{slug}` the user writes. A template without `{slug}` leaves the
 * whole name to the user.
 */
export function slugFrame(template: string): { before: string; after: (slug: string) => string } {
  // The host refuses to save a template with another placeholder, so it always fills.
  const parts = (fillBranchTemplate(template, { slug: '\0' }) ?? '\0').split('\0')
  if (parts.length < 2) return { before: '', after: () => '' }
  return { before: parts[0]!, after: (slug) => parts.slice(1).join(slug) }
}

/**
 * The branch the user named for a project's next worktree: null when Kettu names it, undefined
 * while the project's template is unread.
 */
export function namedBranch(
  s: Pick<WorktreeChoiceStore, 'slug' | 'template'>,
  projectPath: string,
): string | null | undefined {
  if (!s.slug) return null
  const template = s.template[projectPath]
  if (template === undefined) return undefined
  const frame = slugFrame(template)
  return frame.before + s.slug + frame.after(s.slug)
}

/** What holds New session back in the branch the user named for a project, if anything. */
export function branchHold(
  s: WorktreeChoiceStore,
  projectPath: string,
): 'invalid' | 'reading' | 'failed' | null {
  const branch = namedBranch(s, projectPath)
  if (branch === undefined) return s.templateError[projectPath] ? 'failed' : 'reading'
  return branch !== null && branchProblem(branch) !== null ? 'invalid' : null
}

/** What New session asks for a project: null to work in its folder. */
export function worktreeRequest(
  projectPath: string,
  currentBranch: string | null,
): { base: string; branch?: string } | null {
  const state = useWorktreeChoice.getState()
  if (state.where[projectPath] !== 'worktree') return null
  // Before the project's status is read, its checked-out commit: a chosen worktree never quietly
  // becomes the project's folder.
  const from = state.base[projectPath] ?? currentBranch ?? 'HEAD'
  const branch = namedBranch(state, projectPath)
  return { base: from, ...(branch ? { branch } : {}) }
}
