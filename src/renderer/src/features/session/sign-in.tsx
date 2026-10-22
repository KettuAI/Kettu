import { useEffect, useState } from 'react'
import { LogInIcon, RotateCwIcon, SquareTerminalIcon } from 'lucide-react'
import type { AgentAuthMethod } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { emitAppEvent, onAppEvent } from '@renderer/app/events'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName, useAgentsStore } from '@renderer/stores/agents'

const NO_METHODS: AgentAuthMethod[] = []

/** The agent's sign-in methods, in place of a session that cannot start without them. */
export function SignIn({
  agentId,
  projectPath,
  onRetry,
}: {
  agentId: AgentId
  /** Where Sign in in terminal opens its terminal; null before a No project session has one. */
  projectPath: string | null
  onRetry: () => void
}) {
  const methods = useAgentsStore((s) => s.byId[agentId]?.authMethods ?? NO_METHODS)
  const name = agentName(agentId)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'sign-in-finished' && event.agentId === agentId) onRetry()
      }),
    [agentId, onRetry],
  )

  const authenticate = async (method: AgentAuthMethod) => {
    setBusy(method.id)
    setError(null)
    try {
      await host('agents.authenticate', { agentId, methodId: method.id })
      onRetry()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Empty className="animate-in fade-in animation-duration-(--duration-slow)">
      <EmptyHeader>
        <EmptyMedia>
          <AgentTile agent={agentId} />
        </EmptyMedia>
        <EmptyTitle>Sign in to {name}</EmptyTitle>
        <EmptyDescription>
          {name} needs you to sign in before it can start. OverBench never sees your credentials.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-[440px] gap-3">
        {methods.length === 0 && (
          <p className="text-ui text-muted-foreground">
            {name} did not say how to sign in. Sign in with its own command line, then retry.
          </p>
        )}
        {methods.map((method) =>
          method.type === 'terminal' && method.command ? (
            <div
              key={method.id}
              className="flex w-full flex-col gap-2 rounded-xl bg-card p-3 text-left shadow-card"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-ui font-medium">{method.name}</span>
                {method.description && (
                  <span className="text-xs text-muted-foreground">{method.description}</span>
                )}
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-2.5">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  data-selectable=""
                  title={method.command}
                >
                  {method.command}
                </code>
                <CopyButton text={method.command} label="Copy command" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {projectPath !== null && (
                  <Button
                    size="compact"
                    onClick={() =>
                      emitAppEvent({
                        kind: 'sign-in-terminal',
                        projectPath,
                        command: method.command!,
                        agentId,
                      })
                    }
                  >
                    <SquareTerminalIcon data-icon="inline-start" />
                    Sign in in terminal
                  </Button>
                )}
                <Button variant="outline" size="compact" onClick={onRetry}>
                  <RotateCwIcon data-icon="inline-start" />
                  I've signed in, retry
                </Button>
              </div>
            </div>
          ) : (
            <Button
              key={method.id}
              size="compact"
              disabled={busy !== null}
              onClick={() => void authenticate(method)}
              title={method.description}
            >
              {busy === method.id ? (
                <Spinner data-icon="inline-start" className="size-3" />
              ) : (
                <LogInIcon data-icon="inline-start" />
              )}
              {method.name}
            </Button>
          ),
        )}
        {methods.length === 0 && (
          <Button variant="outline" size="compact" onClick={onRetry}>
            <RotateCwIcon data-icon="inline-start" />
            Retry
          </Button>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </EmptyContent>
    </Empty>
  )
}
