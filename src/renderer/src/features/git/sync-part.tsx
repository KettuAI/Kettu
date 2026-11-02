import type { TFunction } from 'i18next'
import { ArrowUpToLineIcon, TriangleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { openGitDialog, useGitStore, type RunningOperation } from '@renderer/stores/git'
import { pushNow, runStep } from './steps'
import {
  commandOf,
  HINT_TONE,
  planSync,
  pushesToDefault,
  pushTargetOf,
  stepOf,
  type SyncButton,
} from './sync'

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

/** How far the branch is from its upstream, then Pull and Push, the next step filled. */
export function SyncStrip({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const plan = planSync(status, gh)
  const words = syncWords(status, t)
  const { head, upstream } = status

  const run = (button: SyncButton): void => {
    const { projectPath } = status
    if (button.kind === 'pull') {
      void runStep(projectPath, { kind: 'pull' })
      return
    }
    const target = pushTargetOf(status)
    if (button.kind === 'push' && target && pushesToDefault(status, 'push')) {
      onClose()
      openGitDialog(projectPath, {
        kind: 'confirmPush',
        operation: { kind: 'push', remote: target.remote, branch: target.branch },
        count: button.count,
      })
      return
    }
    // Publishing asks where to first; a plain push runs at once.
    if (button.kind !== 'push') onClose()
    pushNow(projectPath)
  }

  return (
    <>
      <div className="mt-3 flex gap-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-3.5 rounded-lg bg-subtle px-2.5 text-hint whitespace-nowrap text-secondary tabular">
          {head.detached ? (
            <span className="truncate">{t('popover.detached')}</span>
          ) : !head.oid ? (
            <span className="truncate">{t('popover.unborn')}</span>
          ) : upstream ? (
            <>
              <span>
                <span className="font-medium text-primary">{upstream.ahead}</span>{' '}
                {t('popover.ahead')}
              </span>
              <span>
                <span className="font-medium text-primary">{upstream.behind}</span>{' '}
                {t('popover.behind')}
              </span>
            </>
          ) : (
            <span className="truncate">{t('popover.notPublished')}</span>
          )}
        </div>
        <div role="group" aria-label={t('sync.label')} className="flex shrink-0 gap-1.5">
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
      </div>
      {plan.hint && HINT_TONE[plan.hint] === 'warning' && !running && (
        <p className="mt-2 flex items-start gap-1.5 text-small text-secondary">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t(`hint.${plan.hint}`, words)}</span>
        </p>
      )}
    </>
  )
}

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
  const disabled = !button.enabled || !!running
  const isPush = button.kind !== 'pull'
  const label = t(LABEL_KEY[button.kind])
  const view = (
    <Button
      variant={button.enabled && button.next ? 'default' : 'outline'}
      size="sm"
      disabled={disabled}
      aria-busy={mine || undefined}
      onClick={onRun}
      className={cn('px-2.5 text-hint', mine && 'disabled:opacity-100')}
    >
      {mine ? <Spinner className="size-3.5" /> : isPush && <ArrowUpToLineIcon />}
      {label}
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

const LABEL_KEY = {
  fetch: 'sync.fetch',
  pull: 'sync.pull',
  push: 'sync.push',
  publishBranch: 'sync.push',
  publishRepo: 'sync.publishRepo',
} as const
