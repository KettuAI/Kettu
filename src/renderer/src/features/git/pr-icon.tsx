import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PullRequest, PullRequestState } from '@shared/git'
import { cn } from '@renderer/lib/utils'

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
  size?: number
  className?: string
}) {
  const { t } = useTranslation('git')
  if (!state) {
    return (
      <GitPullRequestIcon
        role="img"
        aria-label={t('pr.icon.none')}
        style={{ width: size, height: size }}

        className={cn('shrink-0 text-icon', className)}
      />
    )
  }
  const { Icon, color, label } = STATE[state]
  return (
    <Icon
      role="img"
      aria-label={t(label)}
      style={{ width: size, height: size }}

      className={cn('shrink-0', color, className)}
    />
  )
}

const CHECKS = {
  passing: { Icon: CircleCheckIcon, color: 'text-success', label: 'pr.checks.passing' },
  failing: { Icon: CircleXIcon, color: 'text-danger', label: 'pr.checks.failing' },
  pending: { Icon: CircleDotIcon, color: 'text-info', label: 'pr.checks.pending' },
} as const

export function ChecksIcon({
  state,
  size = 13,
}: {
  state: PullRequest['checks']['state']
  size?: number
}) {
  const { t } = useTranslation('git')
  if (state === 'none') return null
  const { Icon, color, label } = CHECKS[state]
  return (
    <Icon
      role="img"
      aria-label={t(label)}
      style={{ width: size, height: size }}

      className={cn('shrink-0', color)}
    />
  )
}
