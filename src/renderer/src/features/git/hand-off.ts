// The sentences the popover's hand-off buttons put in the session's composer.

import type { TFunction } from 'i18next'
import type { ChangedFile, GitStatus, PullRequest } from '@shared/git'
import { failingRuns, type NextAction } from './next-step'

/** One sentence for the session's composer; the user reads it, changes it and sends it. */
export function handOffText(
  action: NextAction,
  status: GitStatus,
  pr: PullRequest | null,
  files: readonly ChangedFile[] | null,
  t: TFunction<'git'>,
): string | null {
  const branch = status.head.branch ?? ''
  switch (action) {
    case 'handOffFix': {
      if (!pr) return null
      const names = failingRuns(pr)
      return names.length > 1
        ? t('handOff.fixMany', { number: pr.number, checks: names.slice(0, 4).join(', ') })
        : t('handOff.fix', { number: pr.number, check: names[0] ?? '' })
    }
    case 'handOffConflicts': {
      const conflicted = (files ?? []).filter((file) => file.status === 'conflicted')
      const named = conflicted.slice(0, 5).map((file) => file.path)
      const more = conflicted.length - named.length
      const list = named.join(', ') + (more > 0 ? t('handOff.andMore', { count: more }) : '')
      const operation = status.operation ? t(`handOff.operation.${status.operation.kind}`) : null
      // A conflict with no operation stopped, such as a stash applied, has no operation to name.
      const key = `${operation ? 'stopped' : 'loose'}${list ? 'In' : ''}` as const
      return t(`handOff.${key}`, { operation, branch, files: list })
    }
    case 'handOffRebase':
      return t('handOff.rebase', { branch, upstream: status.upstream?.name ?? '' })
    default:
      return null
  }
}
