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
import { TrayStyles } from './composer/affect-styles'
import { ContextButton } from './composer/usage'
import { AgentWorktreeLine } from './worktree/worktree-tag'

/**
 * In place of the composer: the agent drives a sub-agent, so you can only stop it or go back. Its
 * context shows under it, where the composer's tray shows a session's.
 */
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
  const usage = session?.usage && session.usage.size > 0 ? session.usage : null
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
            variant="destructive-tint"
            className="ks-btn ks-btn--stop"
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
      <div className="flex min-h-9 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          {summary.agentWorktree && <AgentWorktreeLine worktree={summary.agentWorktree} />}
          {error && (
            <p role="alert" className="animate-in truncate px-2 pt-1 text-xs text-danger fade-in">
              {error}
            </p>
          )}
        </div>
        {usage && (
          <span className="kettu-tray__group kettu-tray__group--end pt-1">
            <TrayStyles />
            <ContextButton
              sessionId={summary.id}
              agentId={summary.agentId}
              idle={!running}
              closed={summary.status === 'closed'}
              reports={false}
              direct={false}
              live={false}
              usage={usage}
              limits={[]}
              holding={[]}
              account={null}
              model={null}
            />
          </span>
        )}
      </div>
    </div>
  )
}
