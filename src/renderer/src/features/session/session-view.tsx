import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { markThreadShown } from '@renderer/app/perf'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { usePane } from '@renderer/features/split/pane-context'
import { useScrollbarGutter } from '@renderer/hooks/use-scrollbar-gutter'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { ensureFiles } from '@renderer/stores/files'
import { useSessionsStore } from '@renderer/stores/sessions'
import { focusSession, reloadSession, useThreadsStore } from '@renderer/stores/threads'
import { openSettings } from '@renderer/stores/view'
import { DropOverlay } from './attachments/drop-overlay'
import { useFileDrop } from './attachments/use-file-drop'
import { Composer } from './composer/composer'
import { readDraft } from './composer/drafts'
import { preloadRenderers, useRenderersReady } from './markdown/preload'
import { PlanBar } from './plan-bar'
import { QueueStack } from './queue-stack'
import { SessionHeader } from './session-header'
import {
  ColumnScroller,
  ComposerPlaceholder,
  FailedState,
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
  const progressNotes = useAgentsStore(
    (s) => s.byId[summary.agentId]?.capabilities.progressNotes ?? false,
  )

  useEffect(() => {
    preloadRenderers()
    void focusSession(sessionId)
  }, [sessionId])

  // File references in replies link to the project's files once their list is known.
  useEffect(() => ensureFiles(summary.projectPath), [summary.projectPath])

  const [actionError, setActionError] = useState<string | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
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
    session && summary.origin !== 'subagent' ? sessionId : null,
    status === 'starting',
  )

  let body
  let showsThread = false
  if (!session) {
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
        <SignIn agentId={summary.agentId} projectPath={summary.projectPath} onRetry={retry} />
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
    showsThread = true
    body = (
      <Thread
        sessionId={sessionId}
        projectPath={summary.projectPath}
        agentName={name}
        working={running}
        progressNotes={progressNotes}
      />
    )
  }

  useEffect(() => {
    if (showsThread) markThreadShown(sessionId)
  }, [sessionId, showsThread])

  return (
    <div className="relative flex h-full min-h-0 flex-col" {...drop.handlers}>
      <SessionHeader summary={summary} session={session} />
      <ProjectPathContext value={summary.projectPath}>
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      </ProjectPathContext>
      {/* Leaves the width the column's scrollbar takes, so the composer centres on the column. */}
      <div style={{ paddingRight: gutter }}>
        <div className="px-7 pb-3.5">
          <div className="mx-auto flex w-full max-w-thread flex-col gap-2">
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
            {(actionError || queueError) && (
              <p role="alert" className="animate-in px-1 text-xs text-danger fade-in">
                {actionError ?? queueError}
              </p>
            )}
            <div className="flex flex-col">
              {session && summary.origin !== 'subagent' && (
                <PlanBar
                  sessionId={sessionId}
                  running={running}
                  hidden={queueOpen && session.queue.length > 0}
                />
              )}
              {/* Mounted only while something waits; its cards sit behind the composer. */}
              {session && summary.origin !== 'subagent' && session.queue.length > 0 && (
                <QueueStack session={session} onOpenChange={setQueueOpen} onError={setQueueError} />
              )}
              {summary.origin === 'subagent' ? (
                <SubagentBar summary={summary} session={session} />
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
      <Announcer summary={summary} name={name} />
      <DropOverlay shown={drop.over} starting={status === 'starting'} agentName={name} />
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
 * Number keys 1 to 4 answer the first pending permission request while the composer is empty,
 * and Enter answers it with its highlighted option, unless the focus is on a control of its own.
 */
function usePermissionKeys(sessionId: string, focused: boolean): void {
  useEffect(() => {
    if (!focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return
      const enter = event.key === 'Enter'
      const n = Number(event.key)
      if (!enter && (!Number.isInteger(n) || n < 1 || n > 4)) return
      if (enter && (event.defaultPrevented || event.isComposing || handlesEnter(event.target))) {
        return
      }
      if (isEditable(event.target) || overlayOpen() || readDraft(sessionId).trim()) return
      const state = useThreadsStore.getState().replicas[sessionId]?.state
      if (!state) return
      for (const id of state.order) {
        const entry = state.byId[id]
        if (entry?.kind !== 'tool' || !entry.permission) continue
        // Through the card's own button, so a failure shows where the answer was given.
        const button = document.querySelector<HTMLButtonElement>(
          `[data-entry-id="${CSS.escape(id)}"] ${enter ? '[data-permission-option][data-highlighted]' : `[data-permission-option="${n}"]`}`,
        )
        if (!button || button.disabled) return
        event.preventDefault()
        button.click()
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
