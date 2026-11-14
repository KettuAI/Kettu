import { useState } from 'react'
import {
  ArrowTurnBackwardIcon,
  ComputerIcon,
  Cursor02Icon,
  DashboardSquare01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { SessionView } from '@shared/thread'
import { Spinner } from '@renderer/components/ui/spinner'
import { SHEET_INSIDE } from '@renderer/features/shell/sheet'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { useAppIcon } from './app-icon'

/** How far back from the thread's end a waiting app card is looked for: it follows the agent. */
const WAITING_LOOKBACK = 40

/** Over the session's column while it holds the computer: a fox glow along its edges. */
export function ComputerGlow() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 animate-in fade-in animation-duration-(--duration-slow)"
    >
      <div
        className={cn('absolute inset-0 animate-computer-glow shadow-computer-glow', SHEET_INSIDE)}
      />
    </div>
  )
}

/** The name of the app a card in the session waits on the user to allow, if one does. */
function useWaitingApp(sessionId: string): string | null {
  return useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return null
    const { order, byId } = state
    for (let i = order.length - 1; i >= Math.max(0, order.length - WAITING_LOOKBACK); i--) {
      const entry = byId[order[i]!]
      if (entry?.kind === 'computer_app' && entry.decision === null) return entry.appName
    }
    return null
  })
}

/**
 * On the composer's top edge while the session holds the computer: the app it uses with its icon,
 * what it does there, and Stop using, which ends computer use for the rest of the turn, not the
 * turn. While a new app waits for the user's answer it says so instead.
 */
export function ComputerLabel({
  session,
  agentName,
  onError,
}: {
  session: SessionView
  agentName: string
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation('session')
  const [stopping, setStopping] = useState(false)
  const view = session.computer
  const app = view?.app ?? null
  const icon = useAppIcon(view?.appPath ?? null)
  const waiting = useWaitingApp(session.id)

  const stop = async () => {
    setStopping(true)
    onError(null)
    try {
      await host('computer.stop', { sessionId: session.id })
    } catch (caught) {
      onError(errorMessage(caught))
      setStopping(false)
    }
  }
  const control = (method: 'computer.takeOver' | 'computer.handBack') => {
    onError(null)
    host(method, { sessionId: session.id }).catch((caught: unknown) =>
      onError(errorMessage(caught)),
    )
  }

  const name = <b className="font-semibold" />
  const frame =
    'relative z-20 -mb-px flex h-7.5 max-w-full min-w-0 animate-in items-center gap-2 self-center rounded-t-xl pl-2.5 text-hint whitespace-nowrap fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)'

  if (waiting && !stopping) {
    return (
      <div
        role="status"
        data-computer-label=""
        className={cn(
          frame,
          'bg-card pr-3 text-attention shadow-[0_0_0_var(--hairline)_var(--computer-line)]',
        )}
      >
        <HugeiconsIcon
          icon={DashboardSquare01Icon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.75 shrink-0"
        />
        <span className="min-w-0 truncate">
          <Trans
            t={t}
            i18nKey="computerBar.waiting"
            values={{ app: waiting }}
            components={{ app: name }}
          />
        </span>
      </div>
    )
  }

  if (view?.control === 'you' && !stopping) {
    return (
      <div
        role="status"
        data-computer-label=""
        className={cn(
          frame,
          'bg-card pr-1 text-secondary shadow-[0_0_0_var(--hairline)_var(--border-strong)]',
        )}
      >
        <HugeiconsIcon
          icon={Cursor02Icon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.75 shrink-0 text-primary"
        />
        <span className="min-w-0 truncate">
          <Trans
            t={t}
            i18nKey={app ? 'computerBar.tookOver' : 'computerBar.tookOverComputer'}
            values={{ agent: agentName, app }}
            components={{ app: <b className="font-medium text-primary" /> }}
          />
        </span>
        <button
          type="button"
          onClick={() => control('computer.handBack')}
          className="flex h-5.5 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-small font-medium text-primary-foreground transition-opacity duration-(--duration-fast) outline-none hover:opacity-90 focus-ring"
        >
          <HugeiconsIcon
            icon={ArrowTurnBackwardIcon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.25"
          />
          {t('computerBar.handBack')}
        </button>
      </div>
    )
  }

  return (
    <div
      role="status"
      data-computer-label=""
      className={cn(frame, 'bg-computer-label pr-1 text-(--on-fill)', stopping && 'pr-3')}
    >
      {stopping ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : icon ? (
        <img src={icon} alt="" className="size-4 shrink-0" draggable={false} />
      ) : app ? (
        <HugeiconsIcon
          icon={DashboardSquare01Icon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.75 shrink-0"
        />
      ) : (
        <HugeiconsIcon
          icon={ComputerIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.75 shrink-0"
        />
      )}
      <span className="min-w-0 truncate">
        {stopping ? (
          t('computerBar.stopping')
        ) : app ? (
          <Trans
            t={t}
            i18nKey={view?.action === 'read' ? 'computerBar.looking' : 'computerBar.usingApp'}
            values={{ agent: agentName, app }}
            components={{ app: name }}
          />
        ) : (
          t('computerBar.using', { agent: agentName })
        )}
      </span>
      {!stopping && app && (
        <button
          type="button"
          onClick={() => control('computer.takeOver')}
          className="h-5.5 shrink-0 rounded-md bg-(--on-fill)/20 px-2 text-small font-semibold transition-colors duration-(--duration-fast) outline-none hover:bg-(--on-fill)/30 focus-ring"
        >
          {t('computerBar.takeOver')}
        </button>
      )}
      {!stopping && (
        <button
          type="button"
          onClick={() => void stop()}
          aria-label={t('computerBar.stopLabel')}
          title={t('computerBar.stopLabel')}
          className="h-5.5 shrink-0 rounded-md bg-(--on-fill)/20 px-2 text-small font-semibold transition-colors duration-(--duration-fast) outline-none hover:bg-(--on-fill)/30 focus-ring"
        >
          {t('computerBar.stop')}
        </button>
      )}
    </div>
  )
}
