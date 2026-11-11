import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { openHostSettings } from '@renderer/features/settings/host-sections'
import { usePane } from '@renderer/features/split/pane-context'
import { useScrollbarGutter } from '@renderer/hooks/use-scrollbar-gutter'
import { errorMessage, host } from '@renderer/lib/host'
import { isMac } from '@renderer/lib/platform'
import { agentName, agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { ensureFiles } from '@renderer/stores/files'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { hostOfSession, sessionArchived, useSessionsStore } from '@renderer/stores/sessions'
import { focusSession, reloadSession, useThreadsStore } from '@renderer/stores/threads'
import { openAgentSettings, useViewStore } from '@renderer/stores/view'
import { DropOverlay } from './attachments/drop-overlay'
import { useFileDrop } from './attachments/use-file-drop'
import { Composer } from './composer/composer'
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
import { sessionFolder } from '@renderer/lib/session-folder'

const BoardRail = lazy(() => import('@renderer/features/board/board-pane'))

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
  const hostId = hostOfSession(summary)
  const name = agentName(summary.agentId, hostId)
  const agentRemoved = useAgentsStore(
    (s) => agentsOn(s, hostId).byId[summary.agentId]?.registered === false,
  )
  const agentOff = useAgentsStore(
    (s) => agentsOn(s, hostId).byId[summary.agentId]?.disabled === true,
  )
  const archived = useSessionsStore((s) => sessionArchived(s.byId, sessionId))
  const otherHost = useOtherHost(hostId)
  // Its host is offline: what the thread showed stays, and nothing goes to it.
  const away = otherHost && isAway(otherHost.connection) ? otherHost : null
  // It holds the computer: the column glows and the composer carries the label.
  const computer = !!session?.computer && !archived && !away
  // The board sits at the right of the thread and the composer; a sub-agent's page has none.
  const board = useViewStore((s) => !!s.boardOpen[sessionId]) && summary.origin !== 'subagent'

  useEffect(() => {
    preloadRenderers()
    void focusSession(sessionId)
  }, [sessionId])

  // File references in replies link to the project's files once their list is known.
  const folder = sessionFolder(summary)
  useEffect(() => ensureFiles(folder), [folder])

  const [actionError, setActionError] = useState<string | null>(null)
  // A queued message's failed action; the stack clears it with its next action or its last item.
  const [queueError, setQueueError] = useState<string | null>(null)
  const gutter = useScrollbarGutter()
  const status = session?.status ?? summary.status
  const running = status === 'running' || status === 'awaiting_permission'
  const fail = useCallback((e: unknown) => setActionError(errorMessage(e)), [])
  // Settings › Agents of the host the agent is on.
  const openAgents = (agentId: AgentId | null) => {
    openHostSettings(hostId)
    openAgentSettings(agentId)
  }
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
          <div className="ks-thread__column mx-auto w-full px-8 pt-8">
            <FailedState
              title={t('view.couldntOpen')}
              message={replicaError ?? t('view.hostSilent')}
              onRetry={() => void reloadSession(sessionId)}
              report={{ hostId: otherHost?.id ?? null, sessionId, agentId: summary.agentId }}
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
        <SignIn agentId={summary.agentId} hostId={hostId} panel={summary.id} onRetry={retry} />
      </ColumnScroller>
    )
  } else if (status === 'starting' && empty) {
    body = (
      <ColumnScroller className="flex flex-col">
        <StartingAgent agentId={summary.agentId} hostId={hostId} />
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
    body = <Thread sessionId={sessionId} projectPath={folder} agentName={name} working={running} />
  }

  return (
    <div className="ks-session relative flex h-full min-h-0 flex-col" {...drop.handlers}>
      <SessionHeader summary={summary} session={session} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ProjectPathContext value={folder}>
            {/* The drop zone covers the thread and leaves the composer in view. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {body}
              <DropOverlay shown={drop.over} starting={status === 'starting'} agentName={name} />
            </div>
          </ProjectPathContext>
          {/* Leaves the width the column's scrollbar takes, so the composer centres on the column. */}
          <div style={{ paddingRight: gutter }}>
            <div className="px-8 pb-6">
              <div className="mx-auto flex w-full max-w-(--thread-column) flex-col gap-2">
                {session && status === 'failed' && (
                  <FailedState
                    title={t('view.stopped', { agent: name })}
                    message={session.error?.message ?? t('view.couldNotContinue', { agent: name })}
                    detail={session.error?.detail}
                    onRetry={retry}
                    report={{ hostId: otherHost?.id ?? null, sessionId, agentId: summary.agentId }}
                  />
                )}
                {session && status === 'auth_required' && !empty && (
                  <Alert variant="warning" className="has-data-[slot=alert-action]:pr-36">
                    <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
                    <AlertTitle>{t('view.signInToContinue', { agent: name })}</AlertTitle>
                    <AlertDescription>{t('view.historyStays')}</AlertDescription>
                    <AlertAction className="flex gap-1.5">
                      <Button size="xs" variant="outline" onClick={retry}>
                        {t('common:actions.retry')}
                      </Button>
                      <Button size="xs" onClick={() => openAgents(null)}>
                        {t('view.signIn')}
                      </Button>
                    </AlertAction>
                  </Alert>
                )}
                {agentRemoved && (
                  <Alert variant="warning">
                    <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
                    <AlertTitle>{t('view.agentRemoved', { agent: name })}</AlertTitle>
                    <AlertDescription>{t('view.agentRemovedBody')}</AlertDescription>
                    <AlertAction>
                      <Button size="xs" variant="outline" onClick={() => openAgents(null)}>
                        {t('view.openAgents')}
                      </Button>
                    </AlertAction>
                  </Alert>
                )}
                {agentOff && !agentRemoved && (
                  <Alert variant="warning">
                    <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
                    <AlertTitle>{t('view.agentTurnedOff', { agent: name })}</AlertTitle>
                    <AlertDescription>{t('view.agentTurnedOffBody')}</AlertDescription>
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => openAgents(summary.agentId)}
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
                  ) : session ? (
                    // Its menus open inside it, so while one is open it rises over the computer label.
                    <div className="relative z-10 has-aria-expanded:z-20">
                      {/* An agent removed or turned off: the session goes on with another one. */}
                      <Composer
                        key={sessionId}
                        session={session}
                        agentName={name}
                        mustSwitch={agentRemoved || agentOff}
                      />
                    </div>
                  ) : (
                    <ComposerPlaceholder agentId={summary.agentId} hostId={hostId} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        {board && (
          <Suspense fallback={null}>
            <BoardRail sessionId={sessionId} />
          </Suspense>
        )}
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

/** The most rows a number key picks: 1 to 9. */
const NUMBERED = 9

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], .xterm'))

// A waiting permission card is a dialog of the thread's own, not one over it.
// The composer keeps its menus mounted, hidden and inert, while they are closed.
const overlayOpen = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[role="menu"], [role="dialog"]:not(.ui-prc__card), [role="alertdialog"], [role="listbox"]',
    ),
  ].some((el) => !el.closest('[inert]') && el.checkVisibility({ visibilityProperty: true }))

// What answers Enter itself, so it never also answers a request.
const handlesEnter = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"]',
  )

/**
 * Number keys 1 to 9 pick a row of the first card waiting for the user (a question or a new site)
 * while the composer is empty, Enter allows a request or takes a card's highlighted option, and
 * Mod+Enter confirms any card, unless the focus is on a control of its own.
 */
function usePermissionKeys(sessionId: string, focused: boolean): void {
  useEffect(() => {
    if (!focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.shiftKey || event.repeat) return
      const confirm = event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)
      if (!confirm && (event.metaKey || event.ctrlKey)) return
      const enter = event.key === 'Enter' && !confirm
      const n = Number(event.key)
      if (!enter && !confirm && (!Number.isInteger(n) || n < 1 || n > NUMBERED)) return
      if (event.defaultPrevented || event.isComposing) return
      if (enter && handlesEnter(event.target)) return
      if (isEditable(event.target) || overlayOpen() || readDraft(sessionId).trim()) return
      const id = firstWaiting(sessionId)
      if (!id) return
      // Through the card's own control, so a failure shows where the answer was given: Enter
      // allows a request, Mod+Enter confirms any card, and a number picks that row.
      const scope = `[data-entry-id="${CSS.escape(id)}"]`
      const target = document.querySelector<HTMLElement>(
        confirm
          ? `${scope} :is(.ui-prc__btn--primary, .ui-xcc__action, .ui-apc__approve, [data-answer-enter])`
          : enter
            ? `${scope} :is(.ui-prc__btn--primary, [data-answer-enter], [data-answer-option][data-highlighted])`
            : `${scope} :is([data-answer-option="${n}"], .ui-xcc__rows > .ui-xcc__row:nth-child(${n}))`,
      )
      if (!target || (target instanceof HTMLButtonElement && target.disabled)) return
      event.preventDefault()
      // The row of the user's own answer is a field to type in.
      const field =
        target instanceof HTMLInputElement
          ? target
          : target.querySelector<HTMLInputElement>('input')
      if (field) field.focus()
      else target.click()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId, focused])
}

/** The first card in the thread that waits for the user's answer. */
function firstWaiting(sessionId: string): string | null {
  const state = useThreadsStore.getState().replicas[sessionId]?.state
  if (!state) return null
  for (const id of state.order) {
    const entry = state.byId[id]
    const waiting =
      (entry?.kind === 'tool' && !!entry.permission) ||
      (entry?.kind === 'browser_origin' && entry.decision === null) ||
      (entry?.kind === 'device_access' && entry.decision === null) ||
      (entry?.kind === 'computer_app' && entry.decision === null) ||
      (entry?.kind === 'computer_setup' && entry.outcome === null)
    if (waiting) return id
  }
  return null
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
      // A request or a plan waiting for the user takes Esc as its Deny, as its button shows.
      const waiting = firstWaiting(sessionId)
      const card = waiting
        ? document.querySelector(`[data-entry-id="${CSS.escape(waiting)}"]`)
        : null
      const deny =
        card?.querySelector('.ui-apc__deny') ??
        card?.querySelector('.ui-prc__btn--primary')?.previousElementSibling
      if (deny instanceof HTMLButtonElement) {
        event.preventDefault()
        if (!deny.disabled && deny.getAttribute('aria-disabled') !== 'true') deny.click()
        return
      }
      host('sessions.cancel', { sessionId }).catch(onError)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId, running, focused, onError])
}
