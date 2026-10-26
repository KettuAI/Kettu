import { useRef, useState, type KeyboardEvent } from 'react'
import type { TFunction } from 'i18next'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloudUploadIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'
import { host } from '@renderer/lib/host'
import { Spinner } from '@renderer/components/ui/spinner'
import { loadGitTools, receiveCurrentPr, receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { BranchPopover } from './branch-popover'
import { GitDialogs } from './git-dialogs'
import { ChecksIcon, PrIcon } from './pr-icon'

/** Middle truncation keeps both ends of a branch name, where the meaning usually is. */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

const segment =
  'app-region-no-drag inline-flex h-control items-center gap-1 rounded-lg px-1.5 text-xs whitespace-nowrap text-secondary tabular outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring aria-expanded:bg-hover'

/** The project's repository at a glance: branch, sync, changes, operation, pull request. */
export function GitStatusCluster({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('git')
  const status = useGitStore((s) => s.status[projectPath])
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  const [open, setOpen] = useState(false)
  const popup = useRef<HTMLDivElement>(null)
  if (!status?.repo) return null

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) return
    // Opening shows the repository as it is now, not as the last watch event left it.
    void host('git.status', { projectPath }).then(receiveGitStatus, () => {})
    void host('git.currentPullRequest', { projectPath }).then(
      (current) => receiveCurrentPr(projectPath, current),
      () => {},
    )
    if (!useGitStore.getState().tools) void loadGitTools()
  }

  return (
    <div
      role="group"
      aria-label={t('status.repository')}
      className="inline-flex min-w-0 items-center gap-px"
      onKeyDown={arrowFocus}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          className={cn(segment, 'min-w-0 overflow-hidden')}
          aria-label={branchLabel(status, t)}
        >
          <BranchSummary status={status} />
        </PopoverTrigger>
        <PopoverContent
          ref={popup}
          align="end"
          sideOffset={6}
          initialFocus={() => popup.current?.querySelector<HTMLElement>('[data-git-row]') ?? true}
          className="max-h-(--available-height) w-98 gap-0 overflow-x-hidden overflow-y-auto p-0"
        >
          <BranchPopover status={status} pr={pr} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      <GitDialogs status={status} />
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          tabIndex={-1}
          aria-label={t('status.pullRequest', { number: pr.number })}
          className={cn(segment, 'shrink-0')}
        >
          <PrIcon state={pr.state} size={14} />
          <span className="text-secondary">#{pr.number}</span>
          <ChecksIcon state={pr.checks.state} />
        </a>
      )}
    </div>
  )
}

function branchLabel(status: GitStatus, t: TFunction<'git'>): string {
  return status.head.detached
    ? t('status.detachedAt', { ref: status.head.oid?.slice(0, 7) ?? 'HEAD' })
    : t('status.branch', { name: status.head.branch ?? '' })
}

const RUNNING_KEY = {
  fetch: 'status.running.fetch',
  pull: 'status.running.pull',
  push: 'status.running.push',
  publishBranch: 'status.running.publish',
  publishRepo: 'status.running.publish',
} as const

function BranchSummary({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const running = useGitStore((s) => s.running[status.projectPath]?.kind ?? null)
  const { head, upstream, changes, operation } = status
  const changed = changes.staged + changes.unstaged + changes.untracked
  const unborn = !head.oid
  return (
    <>
      {head.detached ? (
        <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
      ) : (
        <GitBranchIcon className="size-3.5 shrink-0" />
      )}
      {/* The branch takes a quarter of the bar at most and truncates first; below 720 px
          "Not published" keeps only its icon, so the title keeps room. */}
      <span
        className="min-w-0 max-w-[25cqw] truncate font-mono text-xs text-secondary @max-[520px]/top-bar:max-w-24"
        title={head.branch ?? undefined}
      >
        {head.detached
          ? (head.oid?.slice(0, 7) ?? 'HEAD')
          : middleTruncate(head.branch ?? 'HEAD', 28)}
      </span>
      {head.detached && <span>{t('status.detached')}</span>}
      {unborn && !head.detached && <span>{t('status.noCommits')}</span>}
      {/* A pull, push or publish takes the place of the sync arrows, so the popover can close. */}
      {running && running !== 'fetch' ? (
        <span
          role="status"
          aria-label={t(RUNNING_KEY[running])}
          className="ml-1 inline-flex items-center"
        >
          <Spinner className="size-3" />
        </span>
      ) : (
        <>
          {!upstream && !head.detached && !unborn && (
            <span className="ml-1 inline-flex shrink-0 items-center gap-1">
              <CloudUploadIcon className="size-3" />
              <span className="@max-[720px]/top-bar:sr-only">{t('status.notPublished')}</span>
            </span>
          )}
          {upstream && upstream.ahead > 0 && (
            <span
              className="ml-1 inline-flex animate-in items-center gap-px text-secondary animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
              key={`a${upstream.ahead}`}
            >
              <ArrowUpIcon className="size-3" />
              {upstream.ahead}
            </span>
          )}
          {upstream && upstream.behind > 0 && (
            <span
              className={cn(
                'inline-flex animate-in items-center gap-px animation-duration-(--duration-base) fade-in slide-in-from-bottom-1',
                upstream.ahead ? 'ml-0.5' : 'ml-1',
              )}
              key={`b${upstream.behind}`}
            >
              <ArrowDownIcon className="size-3" />
              {upstream.behind}
            </span>
          )}
        </>
      )}
      {operation && (
        <span className="ml-1 font-medium text-secondary">
          {t(OPERATION_KEY[operation.kind])}
          {operation.step && ` ${operation.step[0]}/${operation.step[1]}`}
        </span>
      )}
      {changes.conflicted > 0 ? (
        <span className="ml-1 inline-flex items-center gap-[3px] font-medium text-danger">
          <TriangleAlertIcon className="size-3" />
          {changes.conflicted}
        </span>
      ) : (
        changed > 0 && (
          <span
            className="ml-1 inline-flex animate-in items-center gap-[3px] animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
            key={`c${changed}`}
          >
            <FileDiffIcon className="size-3" />
            {changed}
          </span>
        )
      )}
    </>
  )
}

const OPERATION_KEY = {
  merge: 'status.operation.merge',
  rebase: 'status.operation.rebase',
  'cherry-pick': 'status.operation.cherryPick',
  revert: 'status.operation.revert',
} as const

/** The cluster is one Tab stop; the arrow keys move between its parts. */
function arrowFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const parts = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a'))
  const at = parts.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  event.preventDefault()
  parts[(at + (event.key === 'ArrowRight' ? 1 : -1) + parts.length) % parts.length]?.focus()
}
