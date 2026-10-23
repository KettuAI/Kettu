import { useEffect, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CloudUploadIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
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
  lastLine,
  planSync,
  pushesToDefault,
  pushTargetOf,
  type SyncButton,
} from './sync'

const OPERATION_STEP = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherryPick',
  revert: 'revert',
} as const

/** The upstream and when it was fetched, then Pull and Push, then the next step or a failure. */
export function SyncPart({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const failed = useGitStore((s) => s.failed[status.projectPath] ?? null)
  const plan = planSync(status, gh)
  const upstream = status.upstream?.name ?? status.remote?.name ?? ''
  const words = {
    upstream,
    operation: t(
      `sync.step.${status.operation ? OPERATION_STEP[status.operation.kind] : 'conflicts'}`,
    ),
  }

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
    <div className="flex flex-col gap-2 px-3.5 pt-2 pb-3">
      <div className="-mr-2 flex h-6 items-center gap-1.5 text-xs text-tertiary">
        <span className="min-w-0 flex-1 truncate">
          {status.remote ? (
            <>
              {upstream && <span className="font-mono text-meta">{upstream}</span>}
              {upstream && ' · '}
              {status.lastFetchedAt
                ? t('sync.fetched', { when: longAgo(status.lastFetchedAt, now) })
                : t('sync.neverFetched')}
            </>
          ) : (
            t('sync.noRemote')
          )}
        </span>
        {status.remote && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="quiet"
                  size="icon-xs"
                  aria-label={t('sync.fetch')}
                  disabled={!!running}
                  onClick={() => void runGitOperation(status.projectPath, { kind: 'fetch' })}
                />
              }
            >
              {running?.kind === 'fetch' ? (
                <Spinner className="size-3.5" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>{commandOf(status, 'fetch')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
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
      {failed ? (
        <FailureLine status={status} failed={failed} onClose={onClose} />
      ) : (
        !running &&
        plan.hint && (
          <p className="text-xs leading-normal text-secondary">{t(`hint.${plan.hint}`, words)}</p>
        )
      )}
    </div>
  )
}

const ICON = {
  pull: ArrowDownIcon,
  push: ArrowUpIcon,
  publishBranch: CloudUploadIcon,
  publishRepo: CloudUploadIcon,
  fetch: RefreshCwIcon,
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
  const Icon = ICON[button.kind]
  const enabled = button.enabled && !running
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
      <TooltipTrigger render={<span className="flex min-w-0" />}>
        <Button
          variant={button.next && !running ? 'default' : 'outline'}
          size="compact"
          disabled={!enabled}
          onClick={onRun}
          className={cn('min-w-0 flex-1', mine && 'disabled:opacity-100')}
        >
          {mine ? <Spinner data-icon="inline-start" /> : <Icon data-icon="inline-start" />}
          <span className="truncate">
            {mine ? (
              <Elapsed kind={button.kind} since={running.startedAt} />
            ) : (
              t(LABEL_KEY[button.kind])
            )}
          </span>
          {!mine && button.count > 0 && <span className="tabular opacity-70">{button.count}</span>}
        </Button>
      </TooltipTrigger>
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

function FailureLine({
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
    <div className="-mr-2 flex items-start gap-2 text-xs text-danger">
      <p className="min-w-0 flex-1 pt-1 leading-normal [overflow-wrap:anywhere]">{sentence}</p>
      {failed.log && !failed.busy && (
        <Button
          variant="quiet"
          size="xs"
          onClick={() => {
            onClose()
            openGitDialog(status.projectPath, { kind: 'log' })
          }}
        >
          {t('failure.showLog')}
        </Button>
      )}
    </div>
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
