import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlertIcon, RotateCwIcon } from 'lucide-react'
import type { SessionSummary } from '@shared/agent-host'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { markThreadShown } from '@renderer/app/perf'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { focusSession, reloadSession, useThreadsStore } from '@renderer/stores/threads'
import { Composer } from './composer/composer'
import { readDraft } from './composer/drafts'
import { preloadRenderers, useRenderersReady } from './markdown/preload'
import { PlanBar } from './plan-bar'
import { SessionHeader } from './session-header'
import { FailedState, StartingAgent, ThreadSkeleton } from './session-states'
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
  const sessionId = summary.id
  const replicaStatus = useThreadsStore((s) => s.replicas[sessionId]?.status ?? 'loading')
  const replicaError = useThreadsStore((s) => s.replicas[sessionId]?.error ?? null)
  const empty = useThreadsStore((s) => (s.replicas[sessionId]?.state?.order.length ?? 0) === 0)
  const session = useSessionView(sessionId)
  const renderersReady = useRenderersReady()
  const name = agentName(summary.agentId)

  useEffect(() => {
    preloadRenderers()
    void focusSession(sessionId)
  }, [sessionId])

  const [actionError, setActionError] = useState<string | null>(null)
  const status = session?.status ?? summary.status
  const running = status === 'running' || status === 'awaiting_permission'
  const fail = useCallback((e: unknown) => setActionError(errorMessage(e)), [])
  const retry = () => {
    setActionError(null)
    host('sessions.retry', { sessionId }).catch(fail)
  }

  usePermissionKeys(sessionId)
  useEscapeToCancel(sessionId, !!session && running, fail)

  let body
  let showsThread = false
  if (!session) {
    body =
      replicaStatus === 'error' ? (
        <div className="mx-auto w-full max-w-[760px] px-6 pt-6">
          <FailedState
            title="Couldn't open this session"
            message={replicaError ?? 'The agent host did not answer.'}
            onRetry={() => void reloadSession(sessionId)}
          />
        </div>
      ) : (
        <ThreadSkeleton />
      )
  } else if (status === 'auth_required' && empty) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
        <SignIn agentId={summary.agentId} projectPath={summary.projectPath} onRetry={retry} />
      </div>
    )
  } else if (status === 'starting' && empty) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <StartingAgent agentId={summary.agentId} />
        <ThreadSkeleton className="opacity-70" />
      </div>
    )
  } else if (empty && status === 'ready') {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
        <p className="animate-in text-[15px] text-muted-foreground fade-in animation-duration-(--duration-slow)">
          What should {name} work on?
        </p>
      </div>
    )
  } else if (!renderersReady) {
    body = <ThreadSkeleton />
  } else {
    showsThread = true
    body = (
      <Thread
        sessionId={sessionId}
        projectPath={summary.projectPath}
        agentName={name}
        working={running}
      />
    )
  }

  useEffect(() => {
    if (showsThread) markThreadShown(sessionId)
  }, [sessionId, showsThread])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader summary={summary} />
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2 px-6 pb-3">
        {session && status === 'disconnected' && <Disconnected sessionId={sessionId} name={name} />}
        {session && status === 'failed' && (
          <FailedState
            title={`${name} stopped`}
            message={session.error?.message ?? `${name} could not continue this session.`}
            detail={session.error?.detail}
            onRetry={retry}
          />
        )}
        {session && status === 'auth_required' && !empty && (
          <Alert variant="warning">
            <CircleAlertIcon />
            <AlertTitle>Sign in to {name} to continue</AlertTitle>
            <AlertDescription>
              Your history stays here; the session picks up where it was.
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={retry}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {actionError && (
          <p role="alert" className="animate-in px-1 text-xs text-destructive fade-in">
            {actionError}
          </p>
        )}
        <div className="flex flex-col">
          {session && summary.origin !== 'subagent' && (
            <PlanBar sessionId={sessionId} running={running} />
          )}
          {summary.origin === 'subagent' ? (
            <SubagentBar summary={summary} session={session} />
          ) : session ? (
            <Composer key={sessionId} session={session} agentName={name} />
          ) : (
            <div className="h-[calc(var(--composer-min)+var(--row-height)+4px)]" />
          )}
        </div>
      </div>
      <Announcer summary={summary} name={name} />
    </div>
  )
}

function Disconnected({ sessionId, name }: { sessionId: string; name: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await host('sessions.retry', { sessionId })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Alert className="animate-in fade-in animation-duration-(--duration-base)">
      <Spinner className="size-4 text-muted-foreground" />
      <AlertTitle>{name} stopped unexpectedly. Reconnecting…</AlertTitle>
      {error && <AlertDescription className="text-destructive">{error}</AlertDescription>}
      <AlertAction>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void reconnect()}>
          <RotateCwIcon data-icon="inline-start" />
          Reconnect
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** An aria-live region for permission requests and turn ends, which happen out of view. */
function Announcer({ summary, name }: { summary: SessionSummary; name: string }) {
  const [message, setMessage] = useState('')
  const previous = useRef(summary)
  useEffect(() => {
    const before = previous.current
    previous.current = summary
    if (summary.permissionCount > before.permissionCount) {
      setMessage(`${name} needs your approval`)
    } else if (
      (before.status === 'running' || before.status === 'awaiting_permission') &&
      summary.status === 'ready'
    ) {
      setMessage(`${name} finished`)
    }
  }, [summary, name])
  return (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  )
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], .xterm'))

const overlayOpen = () =>
  !!document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')

/** Number keys 1 to 4 answer the first pending permission request while the composer is empty. */
function usePermissionKeys(sessionId: string): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      const n = Number(event.key)
      if (!Number.isInteger(n) || n < 1 || n > 4) return
      if (isEditable(event.target) || overlayOpen() || readDraft(sessionId).trim()) return
      const state = useThreadsStore.getState().replicas[sessionId]?.state
      if (!state) return
      for (const id of state.order) {
        const entry = state.byId[id]
        if (entry?.kind !== 'tool' || !entry.permission) continue
        // Through the card's own button, so a failure shows where the answer was given.
        const button = document.querySelector<HTMLButtonElement>(
          `[data-entry-id="${CSS.escape(id)}"] [data-permission-option="${n}"]`,
        )
        if (!button || button.disabled) return
        event.preventDefault()
        button.click()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId])
}

/** Esc cancels the running turn from anywhere in the session, unless something else takes it. */
function useEscapeToCancel(
  sessionId: string,
  running: boolean,
  onError: (error: unknown) => void,
): void {
  useEffect(() => {
    if (!running) return
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
  }, [sessionId, running, onError])
}
