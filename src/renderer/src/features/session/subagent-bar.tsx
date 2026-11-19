import { useState } from 'react'
import { AiChat02Icon, ArrowLeft02Icon, StopIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { canonicalClaudeModel } from '@shared/agents'
import type { ConfigOption, SessionView } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { TrayStyles } from './composer/affect-styles'
import { shownChoice } from './composer/model-list'
import { ContextButton } from './composer/usage'
import { useSessionView } from './use-thread'
import { AgentWorktreeLine } from './worktree/worktree-tag'

/** The name the parent's model menu gives the model id a child reported, else the id itself. */
function modelName(config: ConfigOption[] | undefined, id: string): string {
  const choices = config?.find((o) => o.category === 'model')?.choices ?? []
  const key = canonicalClaudeModel(id)
  const choice = choices.find((c) => c.modelId && canonicalClaudeModel(c.modelId) === key)
  return (choice && shownChoice(choices, choice.value)?.name) ?? id
}

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
  const parentConfig = useSessionView(summary.parentId ?? '')?.config
  const ownModel = session?.subagent?.model
  const model = ownModel ? modelName(parentConfig, ownModel) : null
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
        {(usage || model) && (
          <span className="kettu-tray__group kettu-tray__group--end pt-1">
            <TrayStyles />
            {model && (
              <span className="ui-as-tray-link" data-static="" title={ownModel}>
                <AgentMark agent={summary.agentId} size={13} />
                <span className="kettu-tray-link__text">{model}</span>
              </span>
            )}
            {usage && (
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
                model={model}
                subagent
              />
            )}
          </span>
        )}
      </div>
    </div>
  )
}
