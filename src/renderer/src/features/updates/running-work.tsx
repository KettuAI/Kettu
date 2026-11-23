import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BackgroundWork, BusySession, BusyTerminal } from '@shared/host-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { runningFor } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { sessionTitle } from '@renderer/stores/sessions'
import { Glyph } from '@renderer/features/shell/glyph'

/** What a session runs beside a turn, which the quit stops too: its names, then its jobs. */
function backgroundText(work: BackgroundWork): string {
  const parts = [...work.commands, ...work.tasks, ...work.subagents]
  if (work.scheduled > 0) parts.push(i18n.t('updates:quit.scheduled', { count: work.scheduled }))
  if (work.unnamed) parts.push(i18n.t('updates:quit.backgroundWork'))
  return parts.join(i18n.t('updates:quit.workSeparator'))
}

/** The working sessions and running terminal commands a quit or restart would stop. */
export function RunningWorkList({
  sessions,
  terminals,
  now,
}: {
  sessions: BusySession[]
  terminals: BusyTerminal[]
  now: number
}) {
  const { t } = useTranslation('updates')
  return (
    <ul className="mt-3.5 flex min-w-0 flex-col text-ui">
      {sessions.map((s) => (
        <li
          key={s.sessionId}
          className="flex h-8.5 items-center gap-2.5 border-b border-border-soft"
        >
          <AgentMark agent={s.agentId} size={16} />
          <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
          {s.turnStartedAt !== null ? (
            <span className="flex shrink-0 items-center gap-2 text-small text-tertiary tabular">
              <RingSpinner aria-hidden />
              {runningFor(now - s.turnStartedAt)}
            </span>
          ) : (
            s.background && (
              <span className="max-w-1/2 min-w-0 truncate text-small text-tertiary">
                {t('quit.background', { work: backgroundText(s.background) })}
              </span>
            )
          )}
        </li>
      ))}
      {terminals.map((terminal) => (
        <li
          key={terminal.id}
          className="flex h-8.5 items-center gap-2.5 border-b border-border-soft"
        >
          <Glyph icon={ComputerTerminal01Icon} className="text-icon" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{terminal.title}</span>
          <span className="text-small text-tertiary">{t('quit.terminal')}</span>
        </li>
      ))}
    </ul>
  )
}
