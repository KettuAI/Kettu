import { useState } from 'react'
import { MonitorIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { errorMessage, host } from '@renderer/lib/host'

/**
 * Above the composer while the session holds the computer: the app it last read or drove, with
 * Stop, which ends computer use for the rest of the turn.
 */
export function ComputerBar({
  session,
  onError,
}: {
  session: SessionView
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation('session')
  const [stopping, setStopping] = useState(false)
  const app = session.computer?.app ?? null
  const stop = async () => {
    setStopping(true)
    onError(null)
    try {
      await host('computer.stop', { sessionId: session.id })
    } catch (caught) {
      onError(errorMessage(caught))
    } finally {
      setStopping(false)
    }
  }
  return (
    <div
      role="status"
      className="mx-auto mb-2 flex h-7.5 max-w-full min-w-0 animate-in items-center gap-2 rounded-xl pr-1 pl-2.5 text-hint whitespace-nowrap text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] fade-in animation-duration-(--duration-fast)"
      data-computer-bar=""
    >
      <AgentMark agent={session.agentId} size={14} />
      <MonitorIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
      <span className="min-w-0 truncate">
        {app ? t('computerBar.usingApp', { app }) : t('computerBar.using')}
      </span>
      <button
        type="button"
        onClick={() => void stop()}
        disabled={stopping}
        aria-label={t('computerBar.stopLabel')}
        className="h-5.5 shrink-0 rounded-md bg-subtle px-2 text-small font-medium text-primary transition-colors duration-(--duration-fast) outline-none hover:bg-selected focus-ring disabled:opacity-60"
      >
        {t('computerBar.stop')}
      </button>
    </div>
  )
}
