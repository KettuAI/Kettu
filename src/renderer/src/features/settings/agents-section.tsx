import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLinkIcon, LogOutIcon, RefreshCwIcon, RotateCwIcon } from 'lucide-react'
import type { AgentStatus } from '@shared/agent-host'
import { emitAppEvent } from '@renderer/app/events'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { readiness } from '@renderer/features/agents/readiness'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { LimitsPart } from '@renderer/features/session/composer/usage'
import { longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { isInstalled, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { refreshLimits } from '@renderer/stores/usage'
import { closeSettings, toggleTerminal, useViewStore } from '@renderer/stores/view'

function useAction(): [(run: () => Promise<unknown>) => void, boolean, string | null] {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (run: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    run()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }
  return [act, busy, error]
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">{children}</dd>
    </>
  )
}

export function AgentCard({ status }: { status: AgentStatus }) {
  const environment = useAgentsStore((s) => s.environment)
  const override = useSettingsStore((s) => s.settings.agents[status.id]?.binaryPath)
  const [act, busy, error] = useAction()
  const r = readiness(status)
  const limitsReadable =
    status.capabilities.reports && isInstalled(status) && status.signIn !== 'required'
  const running = status.state === 'ready'

  // A running agent's limits are read as the card shows; starting one is left to Check.
  useEffect(() => {
    if (!limitsReadable || !running) return
    refreshLimits(status.id).catch((e: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(e)}`),
    )
  }, [limitsReadable, running, status.id])

  const signInTerminal = (command: string) => {
    const view = useViewStore.getState()
    const projectPath = view.projectPath ?? useProjectsStore.getState().projects[0]?.path
    if (!projectPath) return
    closeSettings()
    toggleTerminal(projectPath, true)
    emitAppEvent({ kind: 'sign-in-terminal', projectPath, command, agentId: status.id })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <AgentTile agent={status.id} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium">{status.name}</span>
            {status.version && (
              <span className="font-mono text-[11.5px] text-muted-foreground">
                v{status.version}
              </span>
            )}
          </span>
          <AgentStateLine status={status} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {r.kind === 'failed' && (
            <Button
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => host('agents.retry', { agentId: status.id }))}
            >
              {busy ? (
                <Spinner data-icon="inline-start" className="size-3" />
              ) : (
                <RotateCwIcon data-icon="inline-start" />
              )}
              Retry
            </Button>
          )}
          {r.kind === 'missing' && r.url && (
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'compact' })}
            >
              {r.action}
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          )}
          {status.canLogout && status.signIn === 'signed-in' && (
            <Button
              size="compact"
              variant="quiet"
              disabled={busy}
              onClick={() => act(() => host('agents.logout', { agentId: status.id }))}
            >
              <LogOutIcon data-icon="inline-start" />
              Sign out
            </Button>
          )}
        </div>
      </div>

      {(r.kind === 'failed' || r.kind === 'missing') && (
        <p
          className={cn(
            'pl-11 text-xs',
            r.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
          data-selectable=""
        >
          {r.message}
        </p>
      )}

      {r.kind === 'sign-in' && status.authMethods.length > 0 && (
        <div className="ml-11 flex flex-col gap-2 rounded-lg bg-attention-tint px-3 py-2.5">
          <span className="text-xs text-foreground">{status.name} needs you to sign in.</span>
          <div className="flex flex-wrap gap-1.5">
            {status.authMethods.map((method) =>
              method.type === 'terminal' && method.command ? (
                <Button
                  key={method.id}
                  size="compact"
                  variant="outline"
                  onClick={() => signInTerminal(method.command!)}
                >
                  {method.name}
                </Button>
              ) : (
                <Button
                  key={method.id}
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      host('agents.authenticate', { agentId: status.id, methodId: method.id }),
                    )
                  }
                >
                  {method.name}
                </Button>
              ),
            )}
          </div>
        </div>
      )}

      <dl className="ml-11 grid grid-cols-[--spacing(14)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        <Detail label="Launch">
          <code
            className="min-w-0 truncate font-mono text-[11.5px]"
            title={status.launchCommand}
            data-selectable=""
          >
            {status.launchCommand}
          </code>
          <CopyButton text={status.launchCommand} label="Copy launch command" />
        </Detail>
        {status.id !== 'opencode' && environment?.nodeVersion && (
          <Detail label="Node.js">
            <span className="font-mono text-[11.5px]">{environment.nodeVersion}</span>
          </Detail>
        )}
        {status.account && (
          <Detail label="Account">
            <span className="truncate">
              {status.account.label}
              {status.account.email && (
                <span className="text-muted-foreground"> · {status.account.email}</span>
              )}
            </span>
          </Detail>
        )}
        {limitsReadable && !running && status.limits.length === 0 && (
          <Detail label="Usage">
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => act(() => refreshLimits(status.id))}
            >
              {busy && <Spinner data-icon="inline-start" className="size-3" />}
              Check plan limits
            </Button>
          </Detail>
        )}
        {status.id === 'opencode' && (
          <Detail label="Program">
            <span
              className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground"
              title={override}
            >
              {override ?? 'opencode on PATH'}
            </span>
            {override && (
              <Button
                variant="quiet"
                size="xs"
                onClick={() =>
                  act(() =>
                    useSettingsStore
                      .getState()
                      .update({ agents: { opencode: { binaryPath: null } } }),
                  )
                }
              >
                Reset
              </Button>
            )}
            <Button
              variant="outline"
              size="xs"
              onClick={() => act(() => window.overbench.dialogs.chooseAgentBinary('opencode'))}
            >
              Choose binary…
            </Button>
          </Detail>
        )}
      </dl>

      {status.limits.length > 0 && (
        <div className="ml-11 -mx-3.5 rounded-lg">
          <LimitsPart limits={status.limits} account={status.account} />
        </div>
      )}
      {error && <p className="ml-11 text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function EnvironmentFooter() {
  const environment = useAgentsStore((s) => s.environment)
  const now = useNow()
  const [act, busy, error] = useAction()
  const source = environment?.source
  const text =
    !environment || source === 'pending'
      ? 'Reading your environment…'
      : source === 'login-shell'
        ? `Read from your login shell${environment.shell ? ` (${environment.shell})` : ''}${
            environment.resolvedAt ? ` ${longAgo(environment.resolvedAt, now)}` : ''
          }${environment.durationMs ? ` in ${environment.durationMs} ms` : ''}.`
        : source === 'inherited'
          ? 'Inherited from how OverBench was started.'
          : 'Using a fallback PATH.'
  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">{text}</span>
        <Button
          variant="quiet"
          size="xs"
          disabled={busy}
          onClick={() => act(() => useAgentsStore.getState().reloadEnvironment())}
        >
          {busy ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Reload environment
        </Button>
      </div>
      {environment?.warning && <p className="text-xs text-attention-text">{environment.warning}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
