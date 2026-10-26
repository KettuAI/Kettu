import { useRef, useState, type KeyboardEvent } from 'react'
import type { Popover as PopoverPrimitive } from '@base-ui/react/popover'
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
import type { GitStatus, PullRequest } from '@shared/git'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { loadGitTools, receiveCurrentPr, receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { BranchPopover } from './branch-popover'
import { GitDialogs } from './git-dialogs'
import { branchName, followPointer, popoverKeys } from './popover-keys'
import { ChecksIcon, PrIcon } from './pr-icon'
import { prStateText } from './pr-text'

/** Middle truncation keeps both ends of a branch name, where the meaning usually is. */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/** The branch chip: a quiet button at the small control height, filled under the pointer. */
const CHIP =
  'app-region-no-drag inline-flex h-control-sm items-center rounded-md px-2 text-xs whitespace-nowrap text-secondary tabular outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring aria-expanded:bg-hover aria-expanded:text-primary'

/** The project's repository at a glance: the branch and its state, then the pull request. */
export function GitStatusCluster({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('git')
  const status = useGitStore((s) => s.status[projectPath])
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  const [open, setOpen] = useState(false)
  const popup = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // A commit's card is a popup outside the popover's own, which the same Escape would close too.
  const cardEscape = useRef<Event | null>(null)
  if (!status?.repo) return null

  const onOpenChange = (next: boolean, details: PopoverPrimitive.Root.ChangeEventDetails): void => {
    if (!next && details.reason === 'escape-key' && details.event === cardEscape.current) {
      details.cancel()
      return
    }
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
      className="inline-flex min-w-0 items-center gap-1"
      onKeyDown={arrowFocus}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        {/* Shrinks first in a crowded bar: the name gives way, then all but the icon. */}
        <PopoverTrigger
          ref={trigger}
          className={cn(CHIP, 'min-w-7.5 gap-2.25 overflow-hidden')}
          aria-label={branchLabel(status, t)}
        >
          <BranchSummary status={status} />
        </PopoverTrigger>
        <PopoverContent
          ref={popup}
          align="end"
          sideOffset={6}
          // From the keyboard the first row takes focus, as in a menu; from the pointer, none.
          initialFocus={(type) =>
            type === 'mouse' || type === 'touch' || type === 'pen'
              ? popup.current
              : (popup.current?.querySelector<HTMLElement>('[data-git-row]') ?? true)
          }
          onKeyDown={(event) => {
            // The card closes on Escape from its own row; from another row it is told apart here.
            if (
              event.key === 'Escape' &&
              document.querySelector('[data-slot=hover-card-content][data-open]')
            ) {
              cardEscape.current = event.nativeEvent
            }
            popoverKeys(event, branchName(status))
          }}
          onPointerMove={followPointer}
          className="max-h-[min(47rem,var(--available-height))] w-98 gap-0 overflow-y-auto p-0"
        >
          <BranchPopover status={status} pr={pr} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      <GitDialogs status={status} returnFocus={trigger} />
      {pr && <PrChip pr={pr} />}
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

/** Each part enters when its count changes, so a new commit or a pushed one is noticed. */
const ENTER =
  'animate-in animation-duration-(--duration-base) fade-in slide-in-from-bottom-1 motion-reduce:animate-none'

function BranchSummary({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const running = useGitStore((s) => s.running[status.projectPath]?.kind ?? null)
  const { head, upstream, changes, operation } = status
  const changed = changes.staged + changes.unstaged + changes.untracked
  const unborn = !head.oid
  const Icon = head.detached ? GitCommitHorizontalIcon : GitBranchIcon
  return (
    <>
      <span className="inline-flex min-w-0 items-center gap-1.25">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {/* The name takes a quarter of the bar at most and truncates first; below 720 px
            "Not published" keeps only its icon, so the title keeps room. */}
        <span
          className="max-w-[25cqw] min-w-0 truncate font-mono text-xs @max-[520px]/top-bar:max-w-24"
          title={head.branch ?? undefined}
        >
          {head.detached
            ? (head.oid?.slice(0, 7) ?? 'HEAD')
            : middleTruncate(head.branch ?? 'HEAD', 28)}
        </span>
      </span>
      {head.detached && <span className="shrink-0">{t('status.detached')}</span>}
      {unborn && !head.detached && <span className="shrink-0">{t('status.noCommits')}</span>}
      {/* A pull, push or publish takes the place of the sync arrows, so the popover can close. */}
      {running && running !== 'fetch' ? (
        <span role="status" aria-label={t(RUNNING_KEY[running])} className="inline-flex shrink-0">
          <Spinner aria-hidden className="size-3 text-tertiary" />
        </span>
      ) : (
        <>
          {!upstream && !head.detached && !unborn && (
            <span className="inline-flex shrink-0 items-center gap-1 text-tertiary">
              <CloudUploadIcon aria-hidden className="size-3.5" />
              <span className="@max-[720px]/top-bar:sr-only">{t('status.notPublished')}</span>
            </span>
          )}
          {upstream && upstream.ahead > 0 && (
            <span
              key={`a${upstream.ahead}`}
              className={cn('inline-flex shrink-0 items-center gap-0.5 text-primary', ENTER)}
            >
              <ArrowUpIcon aria-hidden className="size-3" />
              {upstream.ahead}
            </span>
          )}
          {upstream && upstream.behind > 0 && (
            <span
              key={`b${upstream.behind}`}
              className={cn('inline-flex shrink-0 items-center gap-0.5 text-tertiary', ENTER)}
            >
              <ArrowDownIcon aria-hidden className="size-3" />
              {upstream.behind}
            </span>
          )}
        </>
      )}
      {operation && (
        <span className="shrink-0">
          {t(OPERATION_KEY[operation.kind])}
          {operation.step && ` ${operation.step[0]}/${operation.step[1]}`}
        </span>
      )}
      {changes.conflicted > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-danger">
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          {changes.conflicted}
        </span>
      ) : (
        changed > 0 && (
          <span
            key={`c${changed}`}
            className={cn('inline-flex shrink-0 items-center gap-1', ENTER)}
          >
            <FileDiffIcon aria-hidden className="size-3.5" />
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

const CHECKS_KEY = {
  passing: 'pr.checks.passing',
  failing: 'pr.checks.failing',
  pending: 'pr.checks.pending',
} as const

/** The branch's pull request as a chip with its checks; it opens the pull request. */
function PrChip({ pr }: { pr: PullRequest }) {
  const { t } = useTranslation('git')
  const live = pr.state === 'open' || pr.state === 'draft'
  const state =
    live && pr.checks.state !== 'none' ? t(CHECKS_KEY[pr.checks.state]) : prStateText(pr.state)
  const label = t('status.pullRequestState', { number: pr.number, state })
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            tabIndex={-1}
            aria-label={label}
            className="app-region-no-drag inline-flex h-6 shrink-0 items-center gap-1.25 rounded-md px-2 text-xs whitespace-nowrap text-secondary tabular shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring"
          />
        }
      >
        <PrIcon state={pr.state} size={12} />#{pr.number}
        {live && <ChecksIcon state={pr.checks.state} size={12} />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The cluster is one Tab stop; the arrow keys move between its parts. */
function arrowFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const parts = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a'))
  const at = parts.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  event.preventDefault()
  parts[(at + (event.key === 'ArrowRight' ? 1 : -1) + parts.length) % parts.length]?.focus()
}
