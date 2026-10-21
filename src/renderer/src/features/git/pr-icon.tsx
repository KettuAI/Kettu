import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from 'lucide-react'
import type { PullRequest, PullRequestState } from '@shared/git'
import { cn } from '@renderer/lib/utils'

const STATE = {
  open: { Icon: GitPullRequestIcon, color: 'text-success', word: 'open' },
  draft: { Icon: GitPullRequestDraftIcon, color: 'text-muted-foreground', word: 'draft' },
  merged: { Icon: GitMergeIcon, color: 'text-merged', word: 'merged' },
  closed: { Icon: GitPullRequestClosedIcon, color: 'text-destructive', word: 'closed' },
} as const

/** A pull request's state icon in its color; `null` is the neutral icon without gh. */
export function PrIcon({
  state,
  size = 14,
  className,
}: {
  state: PullRequestState | null
  size?: number
  className?: string
}) {
  if (!state) {
    return (
      <GitPullRequestIcon
        role="img"
        aria-label="Pull request"
        style={{ width: size, height: size }}
        strokeWidth={1.8}
        className={cn('shrink-0 text-muted-foreground', className)}
      />
    )
  }
  const { Icon, color, word } = STATE[state]
  return (
    <Icon
      role="img"
      aria-label={`Pull request ${word}`}
      style={{ width: size, height: size }}
      strokeWidth={1.8}
      className={cn('shrink-0', color, className)}
    />
  )
}

const CHECKS = {
  passing: { Icon: CircleCheckIcon, color: 'text-success', label: 'Checks passing' },
  failing: { Icon: CircleXIcon, color: 'text-destructive', label: 'Checks failing' },
  pending: { Icon: CircleDotIcon, color: 'text-attention', label: 'Checks pending' },
} as const

export function ChecksIcon({
  state,
  size = 13,
}: {
  state: PullRequest['checks']['state']
  size?: number
}) {
  if (state === 'none') return null
  const { Icon, color, label } = CHECKS[state]
  return (
    <Icon
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
      strokeWidth={1.8}
      className={cn('shrink-0', color)}
    />
  )
}
