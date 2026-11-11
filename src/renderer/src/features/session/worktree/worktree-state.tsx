import { useEffect, useState } from 'react'
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  InformationCircleIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { SessionWorktree, WorktreeFailure } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { WORKTREE_ICON } from './worktree-icon'

// How often the setup output is read while it runs and is shown.
const POLL_MS = 2000
// The failure's last lines the card shows; the rest is in Show output.
const FAILURE_LINES = 6

interface SetupLog {
  log: string | null
  error: string | null
}

/** The setup output, read while `active`, and again every 2 s while `live`. */
function useSetupLog(sessionId: string, active: boolean, live: boolean): SetupLog {
  const [state, setState] = useState<SetupLog>({ log: null, error: null })
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      host('worktrees.setupLog', { sessionId }).then(
        ({ log }) => !stopped && setState({ log, error: null }),
        (error: unknown) => !stopped && setState((s) => ({ ...s, error: errorMessage(error) })),
      )
      if (live) timer = setTimeout(read, POLL_MS)
    }
    read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId, active, live])
  return state
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join('\n')
}

/**
 * Above the composer, where a session's worktree is not ready: being created or prepared, its
 * preparation failed, or its folder is gone and the next message recreates it.
 */
export function WorktreeState({
  sessionId,
  worktree,
}: {
  sessionId: string
  worktree: SessionWorktree
}) {
  switch (worktree.state) {
    case 'creating':
    case 'setup':
      return <PreparingLine sessionId={sessionId} creating={worktree.state === 'creating'} />
    case 'setup-failed':
      return <SetupFailed sessionId={sessionId} failure={worktree.failure} />
    case 'missing':
    case 'removed':
      return <MissingLine branch={worktree.branch} missing={worktree.state === 'missing'} />
    default:
      return null
  }
}

function PreparingLine({ sessionId, creating }: { sessionId: string; creating: boolean }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const { log, error } = useSetupLog(sessionId, !creating, !creating)
  const last = log ? lastLines(log, 1).trim() : ''
  return (
    <div
      role="status"
      className="flex min-h-7 min-w-0 animate-in items-center gap-2 px-3 text-xs text-secondary fade-in animation-duration-(--duration-base)"
    >
      <Spinner className="size-3.5 shrink-0 text-icon" />
      <span className="shrink-0">{t(creating ? 'worktree.creating' : 'worktree.preparing')}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-tertiary" title={last}>
        {last}
      </span>
      {!creating && (
        <Button variant="ghost" size="xs" className="shrink-0" onClick={() => setOpen(true)}>
          {t('worktree.showOutput')}
          <Glyph icon={ArrowRight01Icon} size={12} data-icon="inline-end" />
        </Button>
      )}
      <OutputDialog open={open} onOpenChange={setOpen} log={log} error={error} />
    </div>
  )
}

function failureText(
  t: ReturnType<typeof useTranslation<'session'>>['t'],
  failure: WorktreeFailure,
) {
  if (failure.stage === 'copy') return t('worktree.failedCopy')
  return failure.exitCode === null
    ? t('worktree.failedStopped')
    : t('worktree.failedSetup', { code: failure.exitCode })
}

function SetupFailed({
  sessionId,
  failure,
}: {
  sessionId: string
  failure: WorktreeFailure | undefined
}) {
  const { t } = useTranslation('session')
  const [busy, setBusy] = useState<'retry' | 'skip' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const output = useSetupLog(sessionId, open, false)
  const detail = failure?.message ? lastLines(failure.message, FAILURE_LINES) : ''

  const run = (action: 'retry' | 'skip') => {
    setBusy(action)
    setError(null)
    const request =
      action === 'retry'
        ? host('worktrees.retrySetup', { sessionId })
        : host('worktrees.skipSetup', { sessionId })
    request.catch((e: unknown) => setError(errorMessage(e))).finally(() => setBusy(null))
  }

  return (
    <div
      role="alert"
      className="flex animate-in flex-col gap-2.5 rounded-xl bg-card px-3.5 py-3 shadow-card fade-in animation-duration-(--duration-base)"
    >
      <div className="flex items-start gap-2">
        <Glyph icon={AlertCircleIcon} className="mt-px size-4 shrink-0 text-danger" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium">{t('worktree.failedTitle')}</span>
          <span className="text-ui text-muted-foreground">
            {failure ? `${failureText(t, failure)} ` : ''}
            {t('worktree.failedWaits')}
          </span>
        </div>
      </div>
      {detail && (
        <pre
          data-selectable=""
          className="ml-6 max-h-40 overflow-auto rounded-lg bg-code-block px-2.5 py-2 font-mono text-meta leading-relaxed whitespace-pre-wrap text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] [overflow-wrap:anywhere]"
        >
          {detail}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        <Button size="compact" disabled={busy !== null} onClick={() => run('retry')}>
          {busy === 'retry' ? (
            <Spinner data-icon="inline-start" className="size-3.5" />
          ) : (
            <Glyph icon={RefreshIcon} data-icon="inline-start" />
          )}
          {t('worktree.retry')}
        </Button>
        <Button
          variant="outline"
          size="compact"
          disabled={busy !== null}
          onClick={() => run('skip')}
        >
          {busy === 'skip' && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t('worktree.skip')}
        </Button>
        <Button variant="ghost" size="compact" onClick={() => setOpen(true)}>
          {t('worktree.showOutput')}
        </Button>
      </div>
      {error && <p className="pl-6 text-xs text-danger">{error}</p>}
      <OutputDialog open={open} onOpenChange={setOpen} log={output.log} error={output.error} />
    </div>
  )
}

function MissingLine({ branch, missing }: { branch: string; missing: boolean }) {
  const { t } = useTranslation('session')
  return (
    <div className="flex min-h-7 min-w-0 animate-in items-start gap-2 px-3 py-1 text-xs text-secondary fade-in animation-duration-(--duration-base)">
      <Glyph icon={InformationCircleIcon} size={14} className="mt-px shrink-0 text-info" />
      <p className="min-w-0">
        <Trans
          t={t}
          i18nKey={missing ? 'worktree.missing' : 'worktree.removed'}
          components={{ branch: <b className="font-mono text-code font-normal">{branch}</b> }}
        />
      </p>
    </div>
  )
}

/** The setup command's whole output, in mono on the code surface. */
function OutputDialog({
  open,
  onOpenChange,
  log,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  log: string | null
  error: string | null
}) {
  const { t } = useTranslation('session')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-2xl max-w-[90vw] gap-3 sm:max-w-[90vw]">
        <DialogTitle className="pr-8 font-sans text-ui font-medium">
          {t('worktree.outputTitle')}
        </DialogTitle>
        {error ? (
          <p className="text-ui text-danger">{t('worktree.outputFailed', { message: error })}</p>
        ) : log === null ? (
          <Skeleton className="h-64 w-full rounded-lg" />
        ) : (
          <pre
            data-selectable=""
            className="max-h-[calc(85vh-9rem)] min-h-24 overflow-auto rounded-lg bg-code-block px-3 py-2.5 font-mono text-code whitespace-pre-wrap shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] [overflow-wrap:anywhere]"
          >
            {log.trim() === '' ? (
              <span className="font-sans text-tertiary">{t('worktree.noOutput')}</span>
            ) : (
              log
            )}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** In place of the composer once the session's worktree and branch are both gone. */
export function WorktreeGoneComposer() {
  const { t } = useTranslation('session')
  return (
    <div className="ks-bar">
      <Glyph icon={WORKTREE_ICON} className="ks-bar__icon size-4 shrink-0" />
      <p>{t('worktree.gone')}</p>
    </div>
  )
}
