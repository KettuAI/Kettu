import { useRef, useState, type KeyboardEvent } from 'react'
import type { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import type { TFunction } from 'i18next'
import {
  Alert02Icon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { host } from '@renderer/lib/host'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'
import { loadGitTools, receiveCurrentPr, receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { BranchPopover } from './branch-popover'
import { BranchSwitcher } from './branch-switcher'
import { useDialogReturn } from './dialog-focus'
import { branchName, followPointer, popoverKeys } from './popover-keys'

/** Middle truncation keeps both ends of a branch name, where the meaning usually is. */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/**
 * The project's branch and its state on the composer's tray; it opens the branch's popover (sync,
 * changes, commits and the pull request), and Option-click opens the branch switcher.
 */
export function BranchTrayLink({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('git')
  const status = useGitStore((s) => s.status[projectPath])
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  const [open, setOpen] = useState<'branch' | 'switch' | null>(null)
  const popup = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useDialogReturn(projectPath, trigger)
  // A commit's card is a popup outside the popover's own, which the same Escape would close too.
  const cardEscape = useRef<Event | null>(null)
  if (!status?.repo) return null

  const refresh = (): void => {
    // Opening shows the repository as it is now, not as the last watch event left it.
    void host('git.status', { projectPath }).then(receiveGitStatus, () => {})
    void host('git.currentPullRequest', { projectPath }).then(
      (current) => receiveCurrentPr(projectPath, current),
      () => {},
    )
    if (!useGitStore.getState().tools) void loadGitTools()
  }

  const onOpenChange = (next: boolean, details: PopoverPrimitive.Root.ChangeEventDetails): void => {
    if (!next && details.reason === 'escape-key' && details.event === cardEscape.current) {
      details.cancel()
      return
    }
    // Option-click switches branches instead.
    if (next && details.event instanceof MouseEvent && details.event.altKey) {
      details.cancel()
      setOpen('switch')
      return
    }
    setOpen(next ? 'branch' : null)
    if (next) refresh()
  }

  const onChipKeys = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      setOpen('switch')
    }
  }

  return (
    <>
      <Popover open={open === 'branch'} onOpenChange={onOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                ref={trigger}
                className="ui-as-tray-link kettu-branch"
                aria-label={branchLabel(status, t)}
                aria-keyshortcuts="Alt+Enter"
                data-switching={open === 'switch' || undefined}
                onKeyDown={onChipKeys}
              />
            }
          >
            <BranchSummary status={status} />
          </TooltipTrigger>
          <TooltipContent>{t('status.chipHint', { alt: formatShortcut('Alt') })}</TooltipContent>
        </Tooltip>
        <PopoverContent
          ref={popup}
          side="top"
          align="start"
          sideOffset={8}
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
          className="kettu-pop kettu-branch-pop max-h-[min(47rem,var(--available-height))] w-89 overflow-y-auto"
        >
          <BranchPopover
            status={status}
            pr={pr}
            onClose={() => setOpen(null)}
            onSwitch={() => setOpen('switch')}
          />
        </PopoverContent>
      </Popover>
      <BranchSwitcher
        status={status}
        open={open === 'switch'}
        anchor={trigger}
        onOpenChange={(next) => setOpen(next ? 'switch' : null)}
      />
    </>
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
  switch: 'status.running.switch',
  commit: 'status.running.commit',
  discard: 'status.running.discard',
} as const

/** Each count enters when it changes, so a new commit or a pushed one is noticed. */
const ENTER =
  'animate-in animation-duration-(--duration-base) fade-in slide-in-from-bottom-1 motion-reduce:animate-none'

function BranchSummary({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const running = useGitStore((s) => s.running[status.projectPath]?.kind ?? null)
  const { head, upstream, changes, operation } = status
  const unborn = !head.oid
  return (
    <>
      <Glyph icon={head.detached ? GitCommitIcon : GitBranchIcon} size={13} />
      {/* The name truncates first. */}
      <span className="kettu-branch__name" title={head.branch ?? undefined}>
        {head.detached
          ? (head.oid?.slice(0, 7) ?? 'HEAD')
          : middleTruncate(head.branch ?? 'HEAD', 28)}
      </span>
      {unborn && !head.detached && (
        <span className="kettu-branch__dim">{t('status.noCommits')}</span>
      )}
      {/* A write takes the place of the counts, so the popover can close while it runs. */}
      {running && running !== 'fetch' ? (
        <span role="status" aria-label={t(RUNNING_KEY[running])} className="inline-flex shrink-0">
          <Spinner aria-hidden className="size-3" />
        </span>
      ) : (
        <>
          {!upstream && !head.detached && !unborn && (
            <span className="kettu-branch__dim">
              <Glyph icon={CloudUploadIcon} size={13} />
              <span className="sr-only">{t('status.notPublished')}</span>
            </span>
          )}
          {upstream && upstream.ahead > 0 && (
            <span
              key={`a${upstream.ahead}`}
              aria-label={t('status.ahead', { count: upstream.ahead })}
              className={cn('kettu-branch__dim', ENTER)}
            >
              ↑{upstream.ahead}
            </span>
          )}
          {upstream && upstream.behind > 0 && (
            <span
              key={`b${upstream.behind}`}
              aria-label={t('status.behind', { count: upstream.behind })}
              className={cn('kettu-branch__dim', ENTER)}
            >
              ↓{upstream.behind}
            </span>
          )}
        </>
      )}
      {operation && (
        <span className="kettu-branch__dim">
          {t(OPERATION_KEY[operation.kind])}
          {operation.step && ` ${operation.step[0]}/${operation.step[1]}`}
        </span>
      )}
      {changes.conflicted > 0 && (
        <span className="kettu-branch__danger">
          <Glyph icon={Alert02Icon} size={13} />
          {changes.conflicted}
        </span>
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
