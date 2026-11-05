import { useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { FolderGit2Icon, FolderIcon, GitBranchIcon, GitCommitHorizontalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitStatus, PullRequest } from '@shared/git'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { hostPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { showSidePane } from '@renderer/stores/view'
import { CopyButton } from './copy-button'
import { branchName } from './popover-keys'
import { PullRequestPart } from './pr-part'
import {
  ChangeRow,
  CommitRows,
  ErrorRow,
  LineCounts,
  LoadingRows,
  PartHead,
  PartRule,
  ROW,
} from './rows'
import { runStep } from './steps'
import { SyncStrip } from './sync-part'
import { commandOf } from './sync'
import { useChanges } from './use-git-data'

export { CopyButton } from './copy-button'

/** Uncommitted files shown before "N more", which opens them in the Files pane. */
const CHANGES_SHOWN = 6
/** The branch's commits shown before "N more". */
const COMMITS_SHOWN = 5

/**
 * The branch with its sync state and Pull and Push, the uncommitted work, the pull request with
 * its checks, the branch's commits, then the folder it is checked out in.
 */
export function BranchPopover({
  status,
  pr,
  onClose,
  onSwitch,
}: {
  status: GitStatus
  pr: PullRequest | null
  onClose: () => void
  onSwitch: () => void
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <Header status={status} onSwitch={onSwitch} />
      <SyncStrip status={status} onClose={onClose} />
      <ChangesPart status={status} onClose={onClose} />
      <PullRequestPart status={status} pr={pr} onClose={onClose} />
      <CommitsPart status={status} onClose={onClose} />
      <WorktreeFooter status={status} />
    </div>
  )
}

function Header({ status, onSwitch }: { status: GitStatus; onSwitch: () => void }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const refresh = useRefresh({ busy: running?.kind === 'fetch' })
  const { head, defaultBranch, remote } = status
  const Icon = head.detached ? GitCommitHorizontalIcon : GitBranchIcon
  const fromBase = defaultBranch && head.branch !== defaultBranch
  const fetched = running?.kind === 'fetch' ? t('sync.fetching') : fetchedText(status, now, t)

  const fetchNow = (): void => {
    void refresh
      .run(async () => {
        // A failed fetch has its toast, so reject to keep the icon from a check.
        if (!(await runStep(status.projectPath, { kind: 'fetch' }))) {
          throw new Error('fetch failed')
        }
      })
      .catch(() => {})
  }

  return (
    <div className="flex items-start gap-2.5">
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="-mx-1 -my-0.5 flex max-w-full min-w-0 items-center gap-1.75 rounded-md px-1 py-0.5 text-left outline-none hover:bg-hover focus-ring"
                onClick={onSwitch}
              />
            }
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-tertiary" />
            <span className="min-w-0 truncate text-row leading-snug font-semibold tracking-[-0.006em] text-primary">
              {branchName(status)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('popover.switchBranch')}</TooltipContent>
        </Tooltip>
        <p className="mt-0.75 ml-5.25 truncate text-small leading-snug text-tertiary">
          {fromBase ? t('popover.fromBase', { base: defaultBranch, fetched }) : fetched}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={t('sync.fetch')}
            aria-busy={refresh.phase === 'turning'}
            disabled={!remote || !!running || refresh.phase === 'turning'}
            onClick={fetchNow}
            className="text-tertiary"
          >
            <RefreshIcon phase={refresh.phase} className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {!remote
            ? t('reason.noRemote')
            : running && running.kind !== 'fetch'
              ? t('sync.waiting')
              : commandOf(status, 'fetch')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function fetchedText(status: GitStatus, now: number, t: TFunction<'git'>): string {
  if (!status.remote) return t('sync.noRemote')
  return status.lastFetchedAt
    ? t('sync.fetched', { when: longAgo(status.lastFetchedAt, now) })
    : t('sync.neverFetched')
}

/** The working tree's changed files with their totals, and Commit…. */
function ChangesPart({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const { changes } = status
  const count = changes.staged + changes.unstaged + changes.untracked + changes.conflicted
  const { data, error } = useChanges(status.projectPath, count > 0)
  if (count === 0) return null
  const files = data ?? []
  const more = files.length - CHANGES_SHOWN
  return (
    <>
      <PartRule />
      <PartHead>
        <span className="font-medium">{t('popover.changes')}</span>
        <LineCounts insertions={changes.insertions} deletions={changes.deletions} />
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          data-git-row=""
          disabled={changes.conflicted > 0 || !!status.operation}
          className="px-2.5 text-hint"
          onClick={() => {
            onClose()
            openGitDialog(status.projectPath, { kind: 'commit', paths: null })
          }}
        >
          {t('popover.commit')}
        </Button>
      </PartHead>
      <div className="mt-1">
        {data ? (
          files
            .slice(0, CHANGES_SHOWN)
            .map((file) => (
              <ChangeRow
                key={file.path}
                status={status}
                file={file}
                commit={null}
                onOpened={onClose}
              />
            ))
        ) : error ? (
          <ErrorRow message={error} />
        ) : (
          <LoadingRows />
        )}
        {more > 0 && (
          <button
            type="button"
            tabIndex={-1}
            data-git-row=""
            className={`${ROW} h-7 text-small text-tertiary`}
            onClick={() => {
              onClose()
              showSidePane(status.projectPath, 'files')
            }}
          >
            {t('timeline.more', { count: more })}
          </button>
        )}
      </div>
    </>
  )
}

/** The commits on this branch and not on the default one, oldest first like a pull request's. */
function CommitsPart({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const [all, setAll] = useState(false)
  const { commits } = status
  const shown = useMemo(
    () => (all ? commits : commits.slice(0, COMMITS_SHOWN)).toReversed(),
    [all, commits],
  )
  if (commits.length === 0) return null
  return (
    <>
      <PartRule />
      <PartHead>
        <span className="font-medium">{t('popover.onBranch')}</span>
        <span className="tabular">{t('popover.commits', { count: commits.length })}</span>
      </PartHead>
      {shown.length < commits.length && (
        <button
          type="button"
          tabIndex={-1}
          data-git-row=""
          className={`${ROW} h-6.5 text-small text-tertiary`}
          onClick={() => setAll(true)}
        >
          {t('timeline.more', { count: commits.length - shown.length })}
        </button>
      )}
      <CommitRows status={status} commits={shown} onOpened={onClose} />
    </>
  )
}

/** The folder the branch is checked out in, a worktree's or the repository's own. */
function WorktreeFooter({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  if (!status.repo) return null
  const root = hostPath(status.repo.root)
  // A linked worktree's git folder is inside the main repository's, under worktrees/.
  const linked = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(status.repo.gitDir)
  const Icon = linked ? FolderGit2Icon : FolderIcon
  return (
    <div className="mt-2 flex items-center gap-1.75 pt-2.5 text-tertiary shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
      <Icon aria-hidden className="size-3.25 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-code-sm" title={root}>
        {root}
      </span>
      <CopyButton
        text={root}
        label={t('popover.copyPath')}
        className="size-5.5"
        iconClassName="size-3"
      />
    </div>
  )
}
