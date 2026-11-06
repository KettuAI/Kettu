import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { usePane } from '@renderer/features/split/pane-context'
import { useScrollbarGutter } from '@renderer/hooks/use-scrollbar-gutter'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { ensureFiles } from '@renderer/stores/files'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { sessionArchived, useSessionsStore } from '@renderer/stores/sessions'
import { focusSession, reloadSession, useThreadsStore } from '@renderer/stores/threads'
import { openAgentSettings, openSettings } from '@renderer/stores/view'
import { DropOverlay } from './attachments/drop-overlay'
import { useFileDrop } from './attachments/use-file-drop'
import { Composer } from './composer/composer'
import { NUMBERED } from './entries/answer-list'
import { readDraft } from './composer/drafts'
import { preloadRenderers, useRenderersReady } from './markdown/preload'
import { ComputerGlow, ComputerLabel } from './computer-bar'
import { QueueStack } from './queue-stack'
import { SessionHeader } from './session-header'
import {
  ArchivedComposer,
  ColumnScroller,
  ComposerPlaceholder,
  FailedState,
  HostAway,
  StartingAgent,
  ThreadSkeleton,
} from './session-states'
import { SignIn } from './sign-in'
import { SubagentBar } from './subagent-bar'
import { Thread } from './thread'
import { useSessionView } from './use-thread'

/** A session: its thread, and the composer or the subagent bar under it. */
export function SessionView({ sessionId }: { sessionId: string }) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!summary) return null
  return <SessionBody summary={summary} />
}

function SessionBody({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation(['session', 'common'])
  const sessionId = summary.id
  const replicaStatus = useThreadsStore((s) => s.replicas[sessionId]?.status ?? 'loading')
  const replicaError = useThreadsStore((s) => s.replicas[sessionId]?.error ?? null)
  const empty = useThreadsStore((s) => (s.replicas[sessionId]?.state?.order.length ?? 0) === 0)
  const session = useSessionView(sessionId)
  const renderersReady = useRenderersReady()
  const name = agentName(summary.agentId)
  const agentRemoved = useAgentsStore((s) => s.byId[summary.agentId]?.registered === false)
  const agentOff = useAgentsStore((s) => s.byId[summary.agentId]?.disabled === true)
  const archived = useSessionsStore((s) => sessionArchived(s.byId, sessionId))
  const otherHost = useOtherHost(hostOfPath(summary.projectPath))
  // Its host is offline: what the thread showed stays, and nothing goes to it.
  const away = otherHost && isAway(otherHost.connection) ? otherHost : null
  // It holds the computer: the column glows and the composer carries the label.
  const computer = !!session?.computer && !archived && !away

  useEffect(() => {
    preloadRenderers()
    void focusSession(sessionId)
  }, [sessionId])

  // File references in replies link to the project's files once their list is known.
  useEffect(() => ensureFiles(summary.projectPath), [summary.projectPath])

  const [actionError, setActionError] = useState<string | null>(null)
  // A queued message's failed action; the stack clears it with its next action or its last item.
  const [queueError, setQueueError] = useState<string | null>(null)
  const gutter = useScrollbarGutter()
  const status = session?.status ?? summary.status
  const running = status === 'running' || status === 'awaiting_permission'
  const fail = useCallback((e: unknown) => setActionError(errorMessage(e)), [])
  const retry = () => {
    setActionError(null)
    host('sessions.retry', { sessionId }).catch(fail)
  }

  const pane = usePane()
  const focused = pane?.focused ?? true
  usePermissionKeys(sessionId, focused)
  useEscapeToCancel(sessionId, !!session && running, focused, fail)
  const drop = useFileDrop(
    session && !archived && summary.origin !== 'subagent' ? sessionId : null,
    status === 'starting',
  )

  let body
  if (!session && away) {
    body = (
      <ColumnScroller className="flex items-center justify-center px-6 pb-16">
        <HostAway host={away} />
      </ColumnScroller>
    )
  } else if (!session) {
    body =
      replicaStatus === 'error' ? (
        <ColumnScroller>
          <div className="mx-auto w-full max-w-thread px-7 pt-7">
            <FailedState
              title={t('view.couldntOpen')}
              message={replicaError ?? t('view.hostSilent')}
              onRetry={() => void reloadSession(sessionId)}
            />
          </div>
        </ColumnScroller>
      ) : (
        // A session that is not live waits for its agent and the whole `session/load` replay; the
        // composer's placeholder says which.
        <ColumnScroller>
          <ThreadSkeleton />
        </ColumnScroller>
      )
  } else if (status === 'auth_required' && empty) {
    body = (
      <ColumnScroller className="flex items-center justify-center">
        <SignIn agentId={summary.agentId} panel={summary.id} onRetry={retry} />
      </ColumnScroller>
    )
  } else if (status === 'starting' && empty) {
    body = (
      <ColumnScroller className="flex flex-col">
        <StartingAgent agentId={summary.agentId} />
        <ThreadSkeleton className="opacity-70" />
      </ColumnScroller>
    )
  } else if (empty && (status === 'ready' || status === 'closed')) {
    body = (
      <ColumnScroller className="flex items-center justify-center px-6 pb-16">
        <p className="animate-in text-ui text-muted-foreground fade-in animation-duration-(--duration-slow)">
          {t('newSession.whatToWorkOn', { agent: name })}
        </p>
      </ColumnScroller>
    )
  } else if (!renderersReady) {
    body = (
      <ColumnScroller>
        <ThreadSkeleton />
      </ColumnScroller>
    )
  } else {
    body = (
      <Thread
        sessionId={sessionId}
        projectPath={summary.projectPath}
        agentName={name}
        working={running}
      />
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col" {...drop.handlers}>
      <SessionHeader summary={summary} session={session} />
      <ProjectPathContext value={summary.projectPath}>
        {/* The drop zone covers the thread and leaves the composer in view. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {body}
          <DropOverlay shown={drop.over} starting={status === 'starting'} agentName={name} />
        </div>
      </ProjectPathContext>
      {/* Leaves the width the column's scrollbar takes, so the composer centres on the column. */}
      <div style={{ paddingRight: gutter }}>
        <div className="px-7 pb-3.5">
          <div className="mx-auto flex w-full max-w-reply flex-col gap-2">
            {session && status === 'failed' && (
              <FailedState
                title={t('view.stopped', { agent: name })}
                message={session.error?.message ?? t('view.couldNotContinue', { agent: name })}
                detail={session.error?.detail}
                onRetry={retry}
              />
            )}
            {session && status === 'auth_required' && !empty && (
              <Alert variant="warning" className="has-data-[slot=alert-action]:pr-36">
                <CircleAlertIcon />
                <AlertTitle>{t('view.signInToContinue', { agent: name })}</AlertTitle>
                <AlertDescription>{t('view.historyStays')}</AlertDescription>
                <AlertAction className="flex gap-1.5">
                  <Button size="xs" variant="outline" onClick={retry}>
                    {t('common:actions.retry')}
                  </Button>
                  <Button size="xs" onClick={() => openSettings('agents')}>
                    {t('view.signIn')}
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {agentRemoved && (
              <Alert variant="warning">
                <CircleAlertIcon />
                <AlertTitle>{t('view.agentRemoved', { agent: name })}</AlertTitle>
                <AlertDescription>{t('view.agentRemovedBody')}</AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="outline" onClick={() => openSettings('agents')}>
                    {t('view.openAgents')}
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {agentOff && !agentRemoved && (
              <Alert variant="warning">
                <CircleAlertIcon />
                <AlertTitle>{t('view.agentTurnedOff', { agent: name })}</AlertTitle>
                <AlertDescription>{t('view.agentTurnedOffBody')}</AlertDescription>
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => openAgentSettings(summary.agentId)}
                  >
                    {t('view.openAgent')}
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {(actionError || queueError) && (
              <p role="alert" className="animate-in px-1 text-xs text-danger fade-in">
                {actionError ?? queueError}
              </p>
            )}
            <div className="flex flex-col" {...(computer ? { 'data-computer-using': '' } : {})}>
              {/* Mounted only while something waits; its cards sit behind the composer. */}
              {session &&
                !archived &&
                summary.origin !== 'subagent' &&
                session.queue.length > 0 && (
                  <QueueStack session={session} onError={setQueueError} />
                )}
              {computer && session && (
                <ComputerLabel session={session} agentName={name} onError={setQueueError} />
              )}
              {away ? (
                session && <HostAway host={away} inline />
              ) : summary.origin === 'subagent' ? (
                <SubagentBar summary={summary} session={session} />
              ) : archived ? (
                <ArchivedComposer sessionId={sessionId} />
              ) : agentRemoved ? (
                <p className="px-3 py-4 text-small text-tertiary">
                  {t('view.agentRemovedComposer')}
                </p>
              ) : agentOff ? (
                <p className="px-3 py-4 text-small text-tertiary">
                  {t('view.agentTurnedOffComposer')}
                </p>
              ) : session ? (
                <div className="relative z-10">
                  <Composer key={sessionId} session={session} agentName={name} />
                </div>
              ) : (
                <ComposerPlaceholder agentId={summary.agentId} />
              )}
            </div>
          </div>
        </div>
      </div>
      {computer && <ComputerGlow />}
      <Announcer summary={summary} name={name} />
    </div>
  )
}

/** An aria-live region for permission requests and turn ends, which happen out of view. */
function Announcer({ summary, name }: { summary: SessionSummary; name: string }) {
  const { t } = useTranslation('session')
  const [event, setEvent] = useState<'approval' | 'finished' | null>(null)
  const previous = useRef(summary)
  useEffect(() => {
    const before = previous.current
    previous.current = summary
    if (summary.permissionCount > before.permissionCount) {
      setEvent('approval')
    } else if (
      (before.status === 'running' || before.status === 'awaiting_permission') &&
      summary.status === 'ready'
    ) {
      setEvent('finished')
    }
  }, [summary])
  return (
    <div aria-live="polite" className="sr-only">
      {event === 'approval'
        ? t('view.announceApproval', { agent: name })
        : event === 'finished'
          ? t('view.announceFinished', { agent: name })
          : ''}
    </div>
  )
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], .xterm'))

const overlayOpen = () =>
  !!document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')

// What answers Enter itself, so it never also answers a request.
const handlesEnter = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"]',
  )

/**
 * Number keys 1 to 9 answer the first card waiting for the user (a permission request, a question
 * or a new site) while the composer is empty, and Enter answers it with its highlighted option,
 * unless the focus is on a control of its own. On a card of questions the numbers only select.
 */
function usePermissionKeys(sessionId: string, focused: boolean): void {
  useEffect(() => {
    if (!focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return
      const enter = event.key === 'Enter'
      const n = Number(event.key)
      if (!enter && (!Number.isInteger(n) || n < 1 || n > NUMBERED)) return
      if (enter && (event.defaultPrevented || event.isComposing || handlesEnter(event.target))) {
        return
      }
      if (isEditable(event.target) || overlayOpen() || readDraft(sessionId).trim()) return
      const state = useThreadsStore.getState().replicas[sessionId]?.state
      if (!state) return
      for (const id of state.order) {
        const entry = state.byId[id]
        const waiting =
          (entry?.kind === 'tool' && !!entry.permission) ||
          (entry?.kind === 'browser_origin' && entry.decision === null) ||
          (entry?.kind === 'device_access' && entry.decision === null) ||
          (entry?.kind === 'computer_app' && entry.decision === null) ||
          (entry?.kind === 'computer_setup' && entry.outcome === null)
        if (!waiting) continue
        // Through the card's own control, so a failure shows where the answer was given. A
        // question card's Enter goes on to its next question, and its own-answer field takes focus.
        const scope = `[data-entry-id="${CSS.escape(id)}"]`
        const target = document.querySelector<HTMLButtonElement | HTMLInputElement>(
          enter
            ? `${scope} [data-answer-enter], ${scope} [data-answer-option][data-highlighted]`
            : `${scope} [data-answer-option="${n}"]`,
        )
        if (!target || target.disabled) return
        event.preventDefault()
        if (target instanceof HTMLInputElement) target.focus()
        else target.click()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId, focused])
}

/** Esc cancels the running turn from anywhere in the session, unless something else takes it. */
function useEscapeToCancel(
  sessionId: string,
  running: boolean,
  focused: boolean,
  onError: (error: unknown) => void,
): void {
  useEffect(() => {
    if (!running || !focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (overlayOpen()) return
      const target = event.target
      // The composer handles its own Esc; other fields keep theirs.
      if (isEditable(target)) return
      host('sessions.cancel', { sessionId }).catch(onError)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId, running, focused, onError])
}
