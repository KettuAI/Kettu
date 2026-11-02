import { useState } from 'react'
import { ArrowLeftIcon, BotIcon, SquareIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

/** In place of the composer: the agent drives a sub-agent, so you can only stop it or go back. */
export function SubagentBar({
  summary,
  session,
}: {
  summary: SessionSummary
  session: SessionView | undefined
}) {
  const { t } = useTranslation('session')
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = summary.status === 'running' || summary.status === 'awaiting_permission'
  const canStop = running && !!session?.subagent?.canCancel
  const parentTitle = parent ? sessionTitle(parent) : ''

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await host('sessions.cancel', { sessionId: summary.id })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStopping(false)
    }
  }

  return (
    // The composer's frame and the row under it, so the bar sits where the composer would.
    <div className="flex flex-col">
      <div className="flex min-h-(--composer-min) items-center gap-2.5 rounded-2xl bg-subtle py-2.5 pr-2.5 pl-3 text-ui text-secondary">
        <span className="grid size-[22px] shrink-0 place-items-center rounded-tile bg-card text-secondary shadow-card">
          <BotIcon aria-hidden strokeWidth={1.4} className="size-[13px]" />
        </span>
        <p className="min-w-0 flex-1 truncate">
          {parent ? (
            <Trans
              t={t}
              i18nKey="subagentBar.runsFor"
              values={{ agent: agentName(summary.agentId) }}
              components={{
                parent: <span className="font-medium text-primary">{parentTitle}</span>,
              }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="subagentBar.runsForParent"
              values={{ agent: agentName(summary.agentId) }}
              components={{ parent: <span className="font-medium text-primary" /> }}
            />
          )}
        </p>
        {canStop && (
          <Button variant="outline" size="sm" disabled={stopping} onClick={() => void stop()}>
            {stopping ? (
              <Spinner data-icon="inline-start" className="size-3.5" />
            ) : (
              <SquareIcon data-icon="inline-start" strokeWidth={1.5} className="size-3.5" />
            )}
            {t('subagentBar.stop')}
          </Button>
        )}
        {parent && (
          <Button
            variant="outline"
            size="sm"
            aria-label={t('subagentBar.back', { title: parentTitle })}
            onClick={() =>
              backTo({ kind: 'session', sessionId: parent.id }, () =>
                openSession(parent.id, parent.projectPath),
              )
            }
          >
            <ArrowLeftIcon data-icon="inline-start" />
            {t('subagentBar.backShort')}
          </Button>
        )}
      </div>
      <div className="flex min-h-9 flex-col">
        {error && (
          <p role="alert" className="animate-in truncate px-2 pt-1 text-xs text-danger fade-in">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
