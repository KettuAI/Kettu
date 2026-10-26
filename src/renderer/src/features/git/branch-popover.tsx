import { GitBranchIcon, GitCommitHorizontalIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { GitStatus, PullRequest } from '@shared/git'
import { CopyButton } from './copy-button'
import { branchName } from './popover-keys'
import { PullRequestPart } from './pr-part'
import { SyncButtons, SyncFooter, SyncNote } from './sync-part'
import { Timeline } from './timeline'

export { CopyButton } from './copy-button'

/**
 * The branch with Pull and Push and the next step, its pull request, its history as a timeline,
 * then the remote with Fetch.
 */
export function BranchPopover({
  status,
  pr,
  onClose,
}: {
  status: GitStatus
  pr: PullRequest | null
  onClose: () => void
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <Header status={status} onClose={onClose} />
      <PullRequestPart status={status} pr={pr} onClose={onClose} />
      <Timeline status={status} onOpened={onClose} />
      <SyncFooter status={status} />
    </div>
  )
}

function Header({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const { head, upstream, base, defaultBranch } = status
  const branch = branchName(status)
  const fromBase = base && defaultBranch && head.branch !== defaultBranch
  const Icon = head.detached ? GitCommitHorizontalIcon : GitBranchIcon
  return (
    <div className="shrink-0 pt-3 pr-3 pb-3.25 pl-3.5">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-1.5 pt-1">
          <Icon aria-hidden className="mt-0.75 size-3.5 shrink-0 text-secondary" />
          <span className="min-w-0 font-mono text-group font-medium tracking-[-0.01em] [overflow-wrap:anywhere]">
            {branch}
          </span>
          <CopyButton text={branch} label={t('popover.copyBranch')} className="-mt-0.5 -ml-1" />
        </div>
        <SyncButtons status={status} onClose={onClose} />
      </div>
      <p className="mt-0.75 pl-5 text-xs text-tertiary">
        {head.detached ? (
          t('popover.detached')
        ) : !head.oid ? (
          t('popover.unborn')
        ) : (
          <>
            {fromBase && (
              <Trans
                t={t}
                i18nKey="popover.from"
                components={{ branch: <span className="font-mono text-meta text-secondary" /> }}
                values={{ name: defaultBranch }}
              />
            )}
            {fromBase && ' · '}
            {upstream ? (
              <Trans
                t={t}
                i18nKey="popover.tracking"
                components={{ branch: <span className="font-mono text-meta text-secondary" /> }}
                values={{ name: upstream.name }}
              />
            ) : (
              t('popover.notPublished')
            )}
          </>
        )}
      </p>
      <SyncNote status={status} onClose={onClose} />
    </div>
  )
}
