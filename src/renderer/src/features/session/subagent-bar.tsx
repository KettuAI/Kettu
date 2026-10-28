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

/** In place of the composer: the agent drives a subagent, so you can only stop it or go back. */
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
    <div className="flex min-h-13 items-center gap-2 rounded-3xl bg-subtle py-2 pr-2 pl-4 text-ui text-secondary">
      <BotIcon className="size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate">
          {parent ? (
            <Trans
              t={t}
              i18nKey="subagentBar.runsFor"
              values={{ agent: agentName(summary.agentId) }}
              components={{
                parent: <span className="font-medium text-foreground">{parentTitle}</span>,
              }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="subagentBar.runsForParent"
              values={{ agent: agentName(summary.agentId) }}
              components={{ parent: <span className="font-medium text-foreground" /> }}
            />
          )}
        </p>
        {error && <p className="truncate text-xs text-danger">{error}</p>}
      </div>
      {canStop && (
        <Button variant="outline" size="sm" disabled={stopping} onClick={() => void stop()}>
          {stopping ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <SquareIcon data-icon="inline-start" className="size-2.5 fill-current" />
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
  )
}
