import { useState } from 'react'
import { AiChat02Icon, ArrowLeft02Icon, StopIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { AgentWorktreeLine } from './worktree/worktree-tag'

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
  const agent = agentName(summary.agentId, hostOfSession(summary))

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
      <div className="ks-bar">
        <HugeiconsIcon
          icon={AiChat02Icon}
          strokeWidth={1.9}
          aria-hidden
          className="ks-bar__icon size-4 shrink-0"
        />
        <p className="min-w-0 flex-1 truncate">
          {parent ? (
            <Trans
              t={t}
              i18nKey="subagentBar.runsFor"
              values={{ agent }}
              components={{
                parent: <b>{parentTitle}</b>,
              }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="subagentBar.runsForParent"
              values={{ agent }}
              components={{ parent: <b /> }}
            />
          )}
        </p>
        {canStop && (
          <Button
            variant="outline"
            className="ks-btn"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? (
              <Spinner data-icon="inline-start" className="size-3.5" />
            ) : (
              <HugeiconsIcon
                icon={StopIcon}
                strokeWidth={1.9}
                aria-hidden
                data-icon="inline-start"
                className="size-3.5"
              />
            )}
            {t('subagentBar.stop')}
          </Button>
        )}
        {parent && (
          <Button
            variant="outline"
            className="ks-btn"
            aria-label={t('subagentBar.back', { title: parentTitle })}
            onClick={() =>
              backTo({ kind: 'session', sessionId: parent.id }, () =>
                openSession(parent.id, parent.projectPath),
              )
            }
          >
            <HugeiconsIcon
              icon={ArrowLeft02Icon}
              strokeWidth={1.9}
              aria-hidden
              data-icon="inline-start"
            />
            {t('subagentBar.backShort')}
          </Button>
        )}
      </div>
      <div className="flex min-h-9 flex-col">
        {summary.agentWorktree && <AgentWorktreeLine worktree={summary.agentWorktree} />}
        {error && (
          <p role="alert" className="animate-in truncate px-2 pt-1 text-xs text-danger fade-in">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
