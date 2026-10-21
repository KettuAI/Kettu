import { useState, type KeyboardEvent } from 'react'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloudUploadIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type { GitStatus } from '@shared/git'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'
import { useGitStore } from '@renderer/stores/git'
import { BranchPopover } from './branch-popover'
import { ChecksIcon, PrIcon } from './pr-icon'

/** Middle truncation keeps both ends of a branch name, where the meaning usually is. */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

const segment =
  'app-region-no-drag inline-flex h-control items-center gap-1 rounded-lg px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent'

/** The project's repository at a glance: branch, sync, changes, operation, pull request. */
export function GitStatusCluster({ projectPath }: { projectPath: string }) {
  const status = useGitStore((s) => s.status[projectPath])
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  const [open, setOpen] = useState(false)
  if (!status?.repo) return null

  return (
    <div
      role="group"
      aria-label="Repository"
      className="inline-flex items-center gap-px"
      onKeyDown={arrowFocus}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className={segment} aria-label={branchLabel(status)}>
          <BranchSummary status={status} />
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-[372px] gap-0 overflow-hidden p-0">
          <BranchPopover status={status} pr={pr} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          tabIndex={-1}
          aria-label={`Pull request #${pr.number}`}
          className={segment}
        >
          <PrIcon state={pr.state} size={14} />
          <span className="text-foreground">#{pr.number}</span>
          <ChecksIcon state={pr.checks.state} />
        </a>
      )}
    </div>
  )
}

function branchLabel(status: GitStatus): string {
  return status.head.detached
    ? `Detached at ${status.head.oid?.slice(0, 7) ?? 'HEAD'}`
    : `Branch ${status.head.branch ?? ''}`
}

function BranchSummary({ status }: { status: GitStatus }) {
  const { head, upstream, changes, operation } = status
  const changed = changes.staged + changes.unstaged + changes.untracked
  const unborn = !head.oid
  return (
    <>
      {head.detached ? (
        <GitCommitHorizontalIcon className="size-3.5" />
      ) : (
        <GitBranchIcon className="size-3.5" />
      )}
      {/* A narrow top bar caps the branch and keeps "Not published" to its icon, so the title keeps room. */}
      <span
        className="min-w-0 truncate font-mono text-xs text-foreground @max-[520px]/top-bar:max-w-24"
        title={head.branch ?? undefined}
      >
        {head.detached
          ? (head.oid?.slice(0, 7) ?? 'HEAD')
          : middleTruncate(head.branch ?? 'HEAD', 28)}
      </span>
      {head.detached && <span>detached</span>}
      {unborn && !head.detached && <span>no commits</span>}
      {!upstream && !head.detached && !unborn && (
        <span className="ml-1 inline-flex items-center gap-1">
          <CloudUploadIcon className="size-[13px]" />
          <span className="@max-[520px]/top-bar:sr-only">Not published</span>
        </span>
      )}
      {upstream && upstream.ahead > 0 && (
        <span
          className="ml-1 inline-flex animate-in items-center gap-px text-foreground animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
          key={`a${upstream.ahead}`}
        >
          <ArrowUpIcon strokeWidth={2} className="size-3" />
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
          <ArrowDownIcon strokeWidth={2} className="size-3" />
          {upstream.behind}
        </span>
      )}
      {operation && (
        <span className="ml-1 font-medium text-attention-text">
          {OPERATION_TEXT[operation.kind]}
          {operation.step && ` ${operation.step[0]}/${operation.step[1]}`}
        </span>
      )}
      {changes.conflicted > 0 ? (
        <span className="ml-1 inline-flex items-center gap-[3px] font-medium text-destructive">
          <TriangleAlertIcon className="size-[13px]" />
          {changes.conflicted}
        </span>
      ) : (
        changed > 0 && (
          <span
            className="ml-1 inline-flex animate-in items-center gap-[3px] animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
            key={`c${changed}`}
          >
            <FileDiffIcon className="size-[13px]" />
            {changed}
          </span>
        )
      )}
    </>
  )
}

const OPERATION_TEXT = {
  merge: 'Merging',
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
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
