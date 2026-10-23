import type { KeyboardEvent } from 'react'
import { GitBranchIcon, GitCommitHorizontalIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { GitStatus, PullRequest } from '@shared/git'
import { isMod } from '@renderer/lib/platform'
import { CopyButton } from './copy-button'
import { PullRequestPart } from './pr-part'
import { SyncPart } from './sync-part'
import { Part, Timeline } from './timeline'

export { CopyButton } from './copy-button'

/** The branch, its history as a timeline, its pull request, then Pull and Push. */
export function BranchPopover({
  status,
  pr,
  onClose,
}: {
  status: GitStatus
  pr: PullRequest | null
  onClose: () => void
}) {
  const { head } = status
  const branch = head.detached ? (head.oid?.slice(0, 7) ?? 'HEAD') : (head.branch ?? 'HEAD')
  return (
    <div className="flex flex-col" onKeyDown={(event) => rowKeys(event, branch)}>
      <Header status={status} branch={branch} />
      <Timeline status={status} onOpened={onClose} />
      <PullRequestPart status={status} pr={pr} onClose={onClose} />
      <Part>
        <SyncPart status={status} onClose={onClose} />
      </Part>
    </div>
  )
}

function Header({ status, branch }: { status: GitStatus; branch: string }) {
  const { t } = useTranslation('git')
  const { head, upstream, base, defaultBranch } = status
  const fromBase = base && defaultBranch && head.branch !== defaultBranch
  return (
    <div className="flex flex-col gap-0.5 px-3.5 pt-3 pb-2.5">
      <div className="-mr-1.5 flex items-center gap-2">
        {head.detached ? (
          <GitCommitHorizontalIcon className="size-4 shrink-0" />
        ) : (
          <GitBranchIcon className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 font-mono text-control font-medium [overflow-wrap:anywhere]">
          {branch}
        </span>
        <CopyButton text={branch} label={t('popover.copyBranch')} />
      </div>
      <span className="pl-6 text-xs text-muted-foreground">
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
                components={{ branch: <span className="font-mono text-meta" /> }}
                values={{ name: defaultBranch }}
              />
            )}
            {fromBase && ' · '}
            {upstream ? (
              <Trans
                t={t}
                i18nKey="popover.tracking"
                components={{ branch: <span className="font-mono text-meta" /> }}
                values={{ name: upstream.name }}
              />
            ) : (
              t('popover.notPublished')
            )}
          </>
        )}
      </span>
    </div>
  )
}

/** Up and Down move through the popover's rows; `Mod+C` off a commit copies the branch name. */
function rowKeys(event: KeyboardEvent<HTMLDivElement>, branch: string): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return
  if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'c') {
    if (window.getSelection()?.toString()) return
    event.preventDefault()
    void navigator.clipboard.writeText(branch)
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-git-row]'))
  if (rows.length === 0) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next =
    at < 0
      ? event.key === 'ArrowDown'
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
  rows[next]?.focus()
}
