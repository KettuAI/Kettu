import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CloudUploadIcon,
  InfoIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  openGitDialog,
  runGitOperation,
  useGitStore,
  type FailedOperation,
  type GitOperationKind,
  type RunningOperation,
} from '@renderer/stores/git'
import {
  commandOf,
  failureOf,
  HINT_TONE,
  lastLine,
  planSync,
  pushesToDefault,
  pushTargetOf,
  stepOf,
  type NoteTone,
  type SyncButton,
} from './sync'
import { Part } from './timeline'

/** The values the reasons and hints name: where the branch tracks, and what blocks it. */
function syncWords(
  status: GitStatus,
  t: TFunction<'git'>,
): { upstream: string; operation: string } {
  return {
    upstream: status.upstream?.name ?? status.remote?.name ?? '',
    operation: t(`sync.step.${stepOf(status)}`),
  }
}

/** Pull and Push beside the branch: the next step with its label and count, the other an arrow. */
export function SyncButtons({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const plan = planSync(status, gh)
  const words = syncWords(status, t)

  const run = (button: SyncButton): void => {
    const { projectPath } = status
    const target = pushTargetOf(status)
    if (button.kind === 'pull') {
      void runGitOperation(projectPath, { kind: 'pull' })
    } else if (button.kind === 'publishRepo') {
      onClose()
      openGitDialog(projectPath, { kind: 'publishRepo' })
    } else if (target && (button.kind === 'push' || button.kind === 'publishBranch')) {
      const operation = { kind: button.kind, remote: target.remote, branch: target.branch }
      if (pushesToDefault(status, button.kind)) {
        onClose()
        openGitDialog(projectPath, { kind: 'confirmPush', operation, count: button.count })
      } else {
        void runGitOperation(projectPath, operation)
      }
    }
  }

  return (
    <div role="group" aria-label={t('sync.label')} className="flex shrink-0 items-center gap-0.5">
      {[plan.pull, plan.push].map((button) => (
        <SyncButtonView
          key={button === plan.pull ? 'pull' : 'push'}
          status={status}
          button={button}
          running={running}
          reason={button.reason && t(`reason.${button.reason}`, words)}
          onRun={() => run(button)}
        />
      ))}
    </div>
  )
}

const ICON = {
  fetch: RefreshCwIcon,
  pull: ArrowDownIcon,
  push: ArrowUpIcon,
  publishBranch: CloudUploadIcon,
  publishRepo: CloudUploadIcon,
} as const

function SyncButtonView({
  status,
  button,
  running,
  reason,
  onRun,
}: {
  status: GitStatus
  button: SyncButton
  running: RunningOperation | null
  reason: string | null
  onRun: () => void
}) {
  const { t } = useTranslation('git')
  const mine = running?.kind === button.kind
  const big = mine || (button.enabled && button.next)
  const disabled = !button.enabled || !!running
  const Icon = ICON[button.kind]
  const label = t(LABEL_KEY[button.kind])
  // Publishing names no count: it sends the whole branch, or creates the repository.
  const shown = button.kind === 'pull' || button.kind === 'push' ? button.count : 0
  const count = shown > 0 && <span className="tabular">{shown}</span>
  const view = big ? (
    <Button
      variant="default"
      size="sm"
      disabled={disabled}
      onClick={onRun}
      className={cn('ml-1', mine && 'disabled:opacity-100')}
    >
      {/* Both labels share one cell, so the button keeps its width when it starts to run. */}
      <span className="grid">
        <span
          className={cn(
            'col-start-1 row-start-1 inline-flex items-center justify-center gap-1',
            mine && 'invisible',
          )}
        >
          <Icon />
          {label}
          {count}
        </span>
        <span
          aria-hidden={!mine}
          className={cn(
            'col-start-1 row-start-1 inline-flex items-center justify-center gap-1',
            !mine && 'invisible',
          )}
        >
          {mine ? <Spinner className="size-3.5" /> : <span className="size-3.5" />}
          {mine ? (
            <Elapsed kind={button.kind} since={running.startedAt} />
          ) : (
            t(RUNNING_KEY[button.kind], { seconds: 0 })
          )}
        </span>
      </span>
    </Button>
  ) : (
    <Button
      variant="quiet"
      size="sm"
      disabled={disabled}
      aria-label={shown > 0 ? `${label} ${shown}` : label}
      onClick={onRun}
      className="min-w-7 px-1.75"
    >
      <Icon />
      {count}
    </Button>
  )
  if (mine) return view
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
      <TooltipTrigger render={<span className="inline-flex" />}>{view}</TooltipTrigger>
      <TooltipContent>
        {reason ?? (running ? t('sync.waiting') : commandOf(status, button.kind))}
      </TooltipContent>
    </Tooltip>
  )
}

/** "Pushing... 3 s", counting while the operation runs. */
function Elapsed({ kind, since }: { kind: GitOperationKind; since: number }) {
  const { t } = useTranslation('git')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return t(RUNNING_KEY[kind], { seconds: Math.max(0, Math.floor((now - since) / 1000)) })
}

const NOTE = {
  ok: { Icon: CircleCheckIcon, box: 'bg-success-tint', icon: 'text-success' },
  info: { Icon: InfoIcon, box: 'bg-info-tint', icon: 'text-info' },
  warning: { Icon: TriangleAlertIcon, box: 'bg-warning-tint', icon: 'text-warning' },
  error: {
    Icon: CircleAlertIcon,
    box: 'bg-danger-tint text-danger shadow-[inset_0_0_0_var(--hairline)_var(--danger-border)]',
    icon: 'text-danger',
  },
} as const

function Note({
  tone,
  children,
  action,
}: {
  tone: NoteTone
  children: ReactNode
  action?: ReactNode
}) {
  const { Icon, box, icon } = NOTE[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'mt-2.75 flex items-start gap-2 rounded-lg py-1.75 pr-2.5 pl-2.25 text-small',
        box,
      )}
    >
      <span className={cn('flex h-lh shrink-0 items-center', icon)}>
        <Icon aria-hidden className="size-3.5" />
      </span>
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</p>
      {action}
    </div>
  )
}

/** Under the branch: what failed, until the next operation, else the next step in words. */
export function SyncNote({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const failed = useGitStore((s) => s.failed[status.projectPath] ?? null)
  if (failed) return <FailureNote status={status} failed={failed} onClose={onClose} />
  const { hint } = planSync(status, gh)
  if (running || !hint) return null
  return <Note tone={HINT_TONE[hint]}>{t(`hint.${hint}`, syncWords(status, t))}</Note>
}

function FailureNote({
  status,
  failed,
  onClose,
}: {
  status: GitStatus
  failed: FailedOperation
  onClose: () => void
}) {
  const { t } = useTranslation('git')
  const kind = failed.busy ? 'busy' : failureOf(failed.log)
  const sentence = t(`failure.${kind}`, {
    operation: t(OPERATION_KEY[failed.kind]),
    detail: lastLine(failed.log),
  })
  return (
    <Note
      tone="error"
      action={
        failed.log &&
        !failed.busy && (
          <button
            type="button"
            className="shrink-0 rounded-sm font-medium text-primary underline decoration-border-strong underline-offset-2 outline-none hover:decoration-current focus-ring"
            onClick={() => {
              onClose()
              openGitDialog(status.projectPath, { kind: 'log' })
            }}
          >
            {t('failure.showLog')}
          </button>
        )
      }
    >
      {sentence}
    </Note>
  )
}

/** The remote and when it was last fetched, with Fetch. */
export function SyncFooter({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const fetching = running?.kind === 'fetch' ? running : null
  const refresh = useRefresh({ busy: !!fetching })
  const { remote } = status

  const fetchNow = (): void => {
    void refresh
      .run(async () => {
        // A failed fetch is shown under the branch, so reject to keep the icon from a check.
        if (!(await runGitOperation(status.projectPath, { kind: 'fetch' }))) {
          throw new Error('fetch failed')
        }
      })
      .catch(() => {})
  }

  return (
    <Part>
      <div className="flex h-9.5 shrink-0 items-center gap-2 pr-1.75 pl-3.5 text-xs text-tertiary">
        <span className="min-w-0 flex-1 truncate tabular">
          {remote ? (
            <>
              {remote.name} ·{' '}
              {fetching ? (
                <Elapsed kind="fetch" since={fetching.startedAt} />
              ) : status.lastFetchedAt ? (
                t('sync.fetched', { when: longAgo(status.lastFetchedAt, now) })
              ) : (
                t('sync.neverFetched')
              )}
            </>
          ) : (
            t('sync.noRemote')
          )}
        </span>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="quiet"
              size="icon-xs"
              aria-label={t('sync.fetch')}
              aria-busy={refresh.phase === 'turning'}
              disabled={!remote || !!running || refresh.phase === 'turning'}
              onClick={fetchNow}
            >
              <RefreshIcon phase={refresh.phase} className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {!remote
              ? t('reason.noRemote')
              : running && !fetching
                ? t('sync.waiting')
                : commandOf(status, 'fetch')}
          </TooltipContent>
        </Tooltip>
      </div>
    </Part>
  )
}

const LABEL_KEY = {
  fetch: 'sync.fetch',
  pull: 'sync.pull',
  push: 'sync.push',
  publishBranch: 'sync.publishBranch',
  publishRepo: 'sync.publishRepo',
} as const

const RUNNING_KEY = {
  fetch: 'sync.running.fetch',
  pull: 'sync.running.pull',
  push: 'sync.running.push',
  publishBranch: 'sync.running.publish',
  publishRepo: 'sync.running.publish',
} as const

const OPERATION_KEY = {
  fetch: 'failure.operation.fetch',
  pull: 'failure.operation.pull',
  push: 'failure.operation.push',
  publishBranch: 'failure.operation.publish',
  publishRepo: 'failure.operation.publish',
} as const
