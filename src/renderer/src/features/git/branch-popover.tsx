import { useMemo, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  FolderLinksIcon,
  GitBranchIcon,
  GitCommitIcon,
} from '@hugeicons/core-free-icons'
import { Glyph } from '@renderer/features/shell/glyph'
import { useTranslation } from 'react-i18next'
import type { GitStatus, PullRequest } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { ghStateOf, useGitStore } from '@renderer/stores/git'
import { BranchTree } from './branch-tree'
import { handOffText } from './hand-off'
import { Journey, NextStepCard } from './next-step-card'
import type { OpenGitPane } from './pane/open-pane'
import { FetchButton } from './fetch-button'
import { branchName, fetchedText, isLinkedWorktree } from './popover-keys'
import { PullRequestPart } from './pr-part'
import { ChangeRow, Count, ErrorRow, LineCounts, LoadingRows, PartHead, ROW } from './rows'
import { useChanges } from './use-git-data'

export { CopyButton } from './copy-button'

/** Uncommitted files shown before "N more", which opens them in the Git pane. */
const CHANGES_SHOWN = 4

/**
 * The branch, how far it is from a merge, the one step to take next, then below, scrolling on
 * their own, the uncommitted work, the pull request with its checks and the branch's commits.
 */
export function BranchPopover({
  status,
  pr,
  onClose,
  onSwitch,
  onHandOff,
  onOpenPane,
}: {
  status: GitStatus
  pr: PullRequest | null
  onClose: () => void
  onSwitch: () => void
  /** Puts a sentence in the session's composer, and closes the popover. */
  onHandOff: (text: string) => void
  /** Opens the Git pane in the session's side panel. */
  onOpenPane: (request: Omit<OpenGitPane, 'panel'>) => void
}) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => ghStateOf(s, hostOfPath(status.projectPath)))
  const count = changeTotal(status)
  const changes = useChanges(status.projectPath, count > 0)
  const fixChecks = (): void => {
    const text = handOffText('handOffFix', status, pr, changes.data, t)
    if (text) onHandOff(text)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0">
        <Header
          status={status}
          onSwitch={onSwitch}
          onExpand={() => {
            onClose()
            onOpenPane({ tab: 'changes' })
          }}
        />
        <Journey status={status} pr={pr} gh={gh} />
        <NextStepCard
          status={status}
          pr={pr}
          gh={gh}
          files={changes.data}
          onClose={onClose}
          onHandOff={onHandOff}
          onOpenPane={onOpenPane}
        />
      </div>
      <div className="-mx-3.5 -mb-3.5 min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
        <ChangesPart
          status={status}
          files={changes}
          count={count}
          onClose={onClose}
          onViewAll={() => {
            onClose()
            onOpenPane({ tab: 'changes' })
          }}
        />
        <PullRequestPart status={status} pr={pr} onClose={onClose} onFix={fixChecks} />
        <BranchTree status={status} onClose={onClose} />
      </div>
    </div>
  )
}

function changeTotal(status: GitStatus): number {
  const { staged, unstaged, untracked, conflicted } = status.changes
  return staged + unstaged + untracked + conflicted
}

function Header({
  status,
  onSwitch,
  onExpand,
}: {
  status: GitStatus
  onSwitch: () => void
  onExpand: () => void
}) {
  const { t } = useTranslation('git')
  const now = useNow()
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const { head, defaultBranch, remote, operation, upstream } = status
  const icon = head.detached ? GitCommitIcon : GitBranchIcon
  const fromBase = defaultBranch && head.branch !== defaultBranch
  const fetched = running?.kind === 'fetch' ? t('sync.fetching') : fetchedText(status, now, t)
  const linked = isLinkedWorktree(status)
  const unpublished = !upstream && !head.detached && !!head.oid && !!remote

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
            <Glyph icon={icon} className="size-4 shrink-0 text-tertiary" />
            <span className="min-w-0 truncate text-row font-semibold text-primary">
              {branchName(status)}
            </span>
            <Glyph icon={ArrowDown01Icon} className="size-3.5 shrink-0 text-tertiary" />
          </TooltipTrigger>
          <TooltipContent>{t('popover.switchBranch')}</TooltipContent>
        </Tooltip>
        <p className="mt-0.75 ml-5.25 flex min-w-0 items-center gap-1.5 text-small leading-snug whitespace-nowrap text-tertiary">
          {linked && <WorktreeMark root={status.repo ? hostPath(status.repo.root) : ''} />}
          <span className="min-w-0 truncate">
            {operation ? (
              <>
                <span className="font-medium text-danger">
                  {t(
                    `status.operation.${operation.kind === 'cherry-pick' ? 'cherryPick' : operation.kind}`,
                  )}
                  {operation.step && ` ${operation.step[0]}/${operation.step[1]}`}
                </span>
                {' · '}
                {fetched}
              </>
            ) : (
              <>
                {fromBase ? t('popover.fromBase', { base: defaultBranch, fetched }) : fetched}
                {unpublished && ` · ${t('popover.notPublished')}`}
              </>
            )}
          </span>
        </p>
      </div>
      <FetchButton status={status} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={t('popover.openInPane')}
              onClick={onExpand}
              className="text-tertiary"
            />
          }
        >
          <Glyph icon={ArrowExpand01Icon} size={14} />
        </TooltipTrigger>
        <TooltipContent>{t('popover.openInPane')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Marks a linked worktree; the folder shows on hover and a click copies it. */
export function WorktreeMark({ root }: { root: string }) {
  const { t } = useTranslation('git')
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full bg-selected px-1.75 text-caption font-medium text-secondary outline-none hover:bg-hover focus-ring"
            onClick={() => {
              void navigator.clipboard.writeText(root).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          />
        }
      >
        <Glyph icon={FolderLinksIcon} size={11} />
        {t('popover.worktree')}
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-code-sm">{root}</span>
        <br />
        {copied ? t('timeline.copied') : t('popover.copyPath')}
      </TooltipContent>
    </Tooltip>
  )
}

/** The working tree's changed files with their totals; the conflicted ones first. */
function ChangesPart({
  status,
  files: loaded,
  count,
  onClose,
  onViewAll,
}: {
  status: GitStatus
  files: ReturnType<typeof useChanges>
  count: number
  onClose: () => void
  onViewAll: () => void
}) {
  const { t } = useTranslation('git')
  const { changes } = status
  const { data, error } = loaded
  const files = useMemo(
    () =>
      (data ?? []).toSorted((a, b) => +(b.status === 'conflicted') - +(a.status === 'conflicted')),
    [data],
  )
  if (count === 0) return null
  const more = files.length - CHANGES_SHOWN
  const conflicts = changes.conflicted > 0
  return (
    <section className="mt-4">
      <PartHead>
        <span>{conflicts ? t('popover.conflictsAndChanges') : t('popover.changes')}</span>
        <Count>{count}</Count>
        {!conflicts && <LineCounts insertions={changes.insertions} deletions={changes.deletions} />}
        <span className="flex-1" />
        <button
          type="button"
          tabIndex={-1}
          data-git-row=""
          className="-mr-1.5 inline-flex h-5.5 items-center rounded-md px-1.5 font-normal text-tertiary outline-none hover:text-primary focus:bg-hover"
          onClick={onViewAll}
        >
          {t('popover.viewAll')}
        </button>
      </PartHead>
      <div className="mt-0.5">
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
            className={`${ROW} h-6.5 text-small text-tertiary`}
            onClick={onViewAll}
          >
            {t('timeline.more', { count: more })}
          </button>
        )}
      </div>
    </section>
  )
}
