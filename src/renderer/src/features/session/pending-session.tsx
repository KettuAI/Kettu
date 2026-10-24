import { useCallback } from 'react'
import { ArrowLeftIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  cancelPendingSession,
  retryPendingSession,
  type PendingSession,
} from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { InputGroup, InputGroupTextarea } from '@renderer/components/ui/input-group'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { FailedState, FirstMessage, StartingAgent, ThreadSkeleton } from './session-states'
import { SignIn } from './sign-in'

/** A session being created: the agent starts, asks you to sign in, or fails. */
export function PendingSessionView({ pending }: { pending: PendingSession }) {
  const { t } = useTranslation('session')
  const name = agentName(pending.agentId)
  const installing = useAgentsStore((s) => s.byId[pending.agentId]?.state === 'installing')
  const parent = useSessionsStore((s) => (pending.parentId ? s.byId[pending.parentId] : undefined))
  const retry = useCallback(() => retryPendingSession(), [])
  const error = pending.error

  let body
  if (error?.code === 'auth_required') {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
        <SignIn agentId={pending.agentId} projectPath={pending.projectPath} onRetry={retry} />
      </div>
    )
  } else if (error) {
    body = (
      <div className="mx-auto w-full max-w-thread px-6 pt-6">
        <FailedState
          title={t('pending.couldntStart', { agent: name })}
          message={error.message}
          onRetry={retry}
        />
      </div>
    )
  } else if (pending.prompt) {
    body = <FirstMessage agentId={pending.agentId} content={pending.prompt} />
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <StartingAgent agentId={pending.agentId} />
        <ThreadSkeleton className="opacity-70" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="min-w-0 gap-1.5">
          {error && (
            <Button
              variant="quiet"
              size="icon-compact"
              aria-label={t('pending.back')}
              onClick={cancelPendingSession}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <span className="truncate px-1.5 text-ui font-medium">
            {parent
              ? t('pending.newSubSessionOf', { title: sessionTitle(parent) })
              : t('newSession.title')}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <AgentMark agent={pending.agentId} size={13} />
            {name}
          </span>
        </NoDrag>
        <span className="flex-1" />
        {pending.projectPath !== null && <HeaderTools projectPath={pending.projectPath} />}
      </TopBar>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      <div className="mx-auto w-full max-w-thread px-6 pb-3">
        <InputGroup variant="composer" data-disabled>
          <InputGroupTextarea
            rows={1}
            disabled
            aria-label={t('newSession.messageAgent', { agent: name })}
            placeholder={
              error
                ? t('pending.notRunning', { agent: name })
                : t(installing ? 'agentStart.installing' : 'agentStart.starting', { agent: name })
            }
            className="min-h-(--composer-min) py-[15px] pl-4 text-prose leading-[22px] md:text-prose"
          />
        </InputGroup>
        <div className="h-row" />
      </div>
    </div>
  )
}
