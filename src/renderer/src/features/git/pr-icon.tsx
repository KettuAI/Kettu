import {
  CircleCheckIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PullRequest, PullRequestState } from '@shared/git'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'

/** The steps of the icon scale these icons are drawn at. */
export type IconSize = 12 | 14 | 16

const ICON_SIZE = { 12: 'size-3', 14: 'size-3.5', 16: 'size-4' } as const

const STATE = {
  open: { Icon: GitPullRequestIcon, color: 'text-success', label: 'pr.icon.open' },
  draft: { Icon: GitPullRequestDraftIcon, color: 'text-icon', label: 'pr.icon.draft' },
  merged: { Icon: GitMergeIcon, color: 'text-merged', label: 'pr.icon.merged' },
  closed: { Icon: GitPullRequestClosedIcon, color: 'text-danger', label: 'pr.icon.closed' },
} as const

/** A pull request's state icon in its state's color; `null` is the neutral icon without gh. */
export function PrIcon({
  state,
  size = 14,
  className,
}: {
  state: PullRequestState | null
  size?: IconSize
  className?: string
}) {
  const { t } = useTranslation('git')
  if (!state) {
    return (
      <GitPullRequestIcon
        role="img"
        aria-label={t('pr.icon.none')}
        className={cn('shrink-0 text-icon', ICON_SIZE[size], className)}
      />
    )
  }
  const { Icon, color, label } = STATE[state]
  return (
    <Icon
      role="img"
      aria-label={t(label)}
      className={cn('shrink-0', ICON_SIZE[size], color, className)}
    />
  )
}

const CHECKS = {
  passing: { Icon: CircleCheckIcon, color: 'text-success', label: 'pr.checks.passing' },
  failing: { Icon: CircleXIcon, color: 'text-danger', label: 'pr.checks.failing' },
} as const

/** The checks' worst state; checks still running turn, as running work does. */
export function ChecksIcon({
  state,
  size = 12,
}: {
  state: PullRequest['checks']['state']
  size?: IconSize
}) {
  const { t } = useTranslation('git')
  if (state === 'none') return null
  if (state === 'pending') {
    return (
      <Spinner
        role="img"
        aria-label={t('pr.checks.pending')}
        className={cn('shrink-0 text-info', ICON_SIZE[size])}
      />
    )
  }
  const { Icon, color, label } = CHECKS[state]
  return (
    <Icon role="img" aria-label={t(label)} className={cn('shrink-0', ICON_SIZE[size], color)} />
  )
}
