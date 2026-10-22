import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LogOutIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentConfigItem, AgentDetails, AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { readiness } from '@renderer/features/agents/readiness'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { LimitsPart } from '@renderer/features/session/composer/usage'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { countdown } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { refreshLimits } from '@renderer/stores/usage'
import {
  closeSettings,
  openAgentSettings,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import { ControlError } from './controls'
import { RowFrame, RowText } from './rows'

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

function limitsReadable(status: AgentStatus): boolean {
  return status.capabilities.reports && isInstalled(status) && status.signIn !== 'required'
}

/**
 * Reads what an agent's row and page show: its account and plan limits, starting an agent that
 * reports them, and its details. True while the account and limits are being read.
 */
function useAgentReads(status: AgentStatus): boolean {
  const [reading, setReading] = useState(true)
  useEffect(() => {
    let current = true
    host('agents.refreshAccount', { agentId: status.id })
      .catch((e: unknown) =>
        console.warn(`Could not read the account and plan limits: ${errorMessage(e)}`),
      )
      .finally(() => {
        if (current) setReading(false)
      })
    return () => {
      current = false
    }
  }, [status.id])
  // Again on each state change, so an adapter installed meanwhile shows its CLI version.
  useEffect(() => {
    useAgentsStore
      .getState()
      .loadDetails(status.id)
      .catch((e: unknown) => console.warn(`Could not read the agent details: ${errorMessage(e)}`))
  }, [status.id, status.state])
  return reading
}

/** The windows whose reset has not passed; an older reading of them no longer holds. */
function currentLimits(limits: PlanLimit[], now: number): PlanLimit[] {
  return limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
}

/** The agent's own version: for a package agent the CLI its adapter runs, never the adapter's. */
function agentVersion(status: AgentStatus, details: AgentDetails | undefined): string | null {
  return details?.cliVersion ?? (status.package ? null : status.version)
}

/** One agent in the list on the Agents page: what it is, who it is signed in as, its usage. */
export function AgentListItem({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const details = useAgentsStore((s) => s.details[status.id])
  const now = useNow()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const version = agentVersion(status, details)
  const account = status.account?.kind === 'none' ? null : status.account
  const limits = currentLimits(status.limits, now)
  // What it needs first; then who it is signed in as; else how it runs or where it is set up.
  const summary: ReactNode =
    r.kind === 'missing' || r.kind === 'failed' ? (
      r.message
    ) : r.kind === 'sign-in' ? (
      t('agents.needsSignIn', { name: status.name })
    ) : account ? (
      <>
        {account.label}
        {account.email && (
          <>
            {' · '}
            <span className="text-foreground/80">{account.email}</span>
          </>
        )}
      </>
    ) : reading && status.capabilities.account ? (
      t('agents.readingAccount')
    ) : status.package && !status.package.installed ? (
      t('agents.installsOnFirstUse')
    ) : (
      (details?.config.find((item) => item.id === 'folder')?.path ?? null)
    )
  const usage =
    limits.length > 0 ? (
      <UsageMeters limits={limits} />
    ) : r.kind === 'missing' ? null : status.capabilities.reports ? (
      <span className="text-xs text-muted-foreground">
        {t(reading ? 'agents.readingUsage' : 'agents.usageOnceRunning')}
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">{t('agents.noUsage')}</span>
    )
  return (
    <button
      type="button"
      onClick={() => openAgentSettings(status.id)}
      className="group/agent flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <AgentTile agent={status.id} mono={r.kind === 'missing'} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ui font-medium">{status.name}</span>
          {version && (
            <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
              {version}
            </span>
          )}
        </div>
        {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        {usage}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-center">
        <AgentStateLine status={status} />
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-hover/agent:translate-x-0.5" />
      </div>
    </button>
  )
}

/** Up to two current windows, each a label, its percentage, the time left and a bar. */
function UsageMeters({ limits }: { limits: PlanLimit[] }) {
  const { t } = useTranslation('composer')
  const now = useNow()
  const shown = limits.slice(0, 2)
  return (
    <div className="mt-1.5 grid max-w-md grid-cols-2 gap-x-6">
      {shown.map((limit) => {
        const left = limit.resetsAt ? countdown(limit.resetsAt - now) : null
        return (
          <div key={limit.window} className="flex min-w-0 flex-col gap-1 text-xs tabular">
            <div className="flex items-baseline gap-1.5">
              <span className="text-muted-foreground">{limitLabel(limit)}</span>
              <span
                className={cn(
                  limit.state === 'warning' && 'text-attention-text',
                  limit.state === 'reached' && 'text-destructive',
                )}
              >
                {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
              </span>
              {left && <span className="ml-auto truncate text-muted-foreground">{left}</span>}
            </div>
            <Progress
              value={limit.usedPercent ?? 0}
              tone={
                limit.state === 'reached'
                  ? 'destructive'
                  : limit.state === 'warning'
                    ? 'attention'
                    : 'default'
              }
              aria-label={t('usage.limits.used', { limit: limitLabel(limit) })}
            />
          </div>
        )
      })}
    </div>
  )
}

/** An agent's own page: its account, usage, configuration and how it launches. */
export function AgentPage({ agentId }: { agentId: AgentId }) {
  const status = useAgentsStore((s) => s.byId[agentId])
  if (!status) return <BackToAgents />
  return <AgentPageBody status={status} />
}

function BackToAgents() {
  const { t } = useTranslation('settings')
  return (
    <Button
      variant="quiet"
      size="compact"
      className="-ml-1 w-max gap-1 px-1.5 text-muted-foreground"
      onClick={() => openAgentSettings(null)}
    >
      <ChevronLeftIcon data-icon="inline-start" />
      {t('sections.agents')}
    </Button>
  )
}

function AgentPageBody({ status }: { status: AgentStatus }) {
  const { t } = useTranslation(['settings', 'common'])
  const environment = useAgentsStore((s) => s.environment)
  const details = useAgentsStore((s) => s.details[status.id])
  const override = useSettingsStore((s) => s.settings.agents[status.id]?.binaryPath)
  const [act, busy, error] = useAction()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const version = agentVersion(status, details)
  const running = status.state === 'ready'

  const signInTerminal = (command: string) => {
    const view = useViewStore.getState()
    const projectPath = view.projectPath ?? useProjectsStore.getState().projects[0]?.path
    if (!projectPath) return
    closeSettings()
    toggleTerminal(projectPath, true)
    emitAppEvent({ kind: 'sign-in-terminal', projectPath, command, agentId: status.id })
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackToAgents />
        <div className="flex items-center gap-3">
          <AgentPicker status={status} />
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                {t('common:actions.retry')}
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
                {t('agents.signOut')}
              </Button>
            )}
          </div>
        </div>

        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="px-1 text-xs text-attention-text" data-selectable="">
            {status.detail}
          </p>
        )}
        {(r.kind === 'failed' || r.kind === 'missing') && (
          <p
            className={cn(
              'px-1 text-xs',
              r.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
            data-selectable=""
          >
            {r.message}
          </p>
        )}
        {r.kind === 'sign-in' && status.authMethods.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg bg-attention-tint px-3 py-2.5">
            <span className="text-xs text-foreground">
              {t('agents.needsSignIn', { name: status.name })}
            </span>
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
        {error && <p className="px-1 text-xs text-destructive">{error}</p>}
      </div>

      <Group title={t('agents.account')}>
        <Fact name={t('agents.version')} mono>
          {version}
        </Fact>
        {/* A subscription's label is its plan; the other kinds name how the agent signs in. */}
        <Fact name={t(status.account?.kind === 'account' ? 'agents.plan' : 'agents.loginMethod')}>
          {status.account?.label}
        </Fact>
        {status.account?.email && <Fact name={t('agents.email')}>{status.account.email}</Fact>}
      </Group>

      <Group title={t('agents.usage')}>
        {status.limits.length > 0 ? (
          <div className="-mx-2.5">
            <LimitsPart limits={status.limits} account={status.account} heading={false} />
          </div>
        ) : reading && status.capabilities.reports ? (
          <p className="px-1 py-3 text-xs text-muted-foreground">{t('agents.readingUsage')}</p>
        ) : limitsReadable(status) && !running ? (
          <RowFrame first text={<RowText name={t('agents.planLimits')} />}>
            <Button
              variant="outline"
              size="compact"
              disabled={busy}
              onClick={() => act(() => refreshLimits(status.id))}
            >
              {busy && <Spinner data-icon="inline-start" className="size-3" />}
              {t('agents.checkLimits')}
            </Button>
          </RowFrame>
        ) : (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {t('agents.usageNotReported', { name: status.name })}
          </p>
        )}
      </Group>

      <Group title={t('agents.configuration')}>
        {details?.config.map((item) => (
          <ConfigRow key={item.id} item={item} />
        ))}
        {status.id === 'opencode' && (
          <RowFrame
            first
            text={
              <RowText
                name={t('agents.program')}
                description={
                  <code className="font-mono text-[11.5px] break-all" data-selectable="">
                    {override ?? t('agents.programOnPath')}
                  </code>
                }
              />
            }
          >
            {override && (
              <Button
                variant="quiet"
                size="compact"
                onClick={() =>
                  act(() =>
                    useSettingsStore
                      .getState()
                      .update({ agents: { opencode: { binaryPath: null } } }),
                  )
                }
              >
                {t('agents.reset')}
              </Button>
            )}
            <Button
              variant="outline"
              size="compact"
              onClick={() => act(() => window.overbench.dialogs.chooseAgentBinary('opencode'))}
            >
              {t('agents.chooseBinary')}
            </Button>
          </RowFrame>
        )}
        {details && details.config.length === 0 && status.id !== 'opencode' && (
          <p className="px-1 py-3 text-xs text-muted-foreground">{t('agents.noConfig')}</p>
        )}
      </Group>

      <Collapsible>
        <CollapsibleTrigger className="group/advanced -ml-1 flex w-max items-center gap-1 rounded-md px-1 text-ui font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform duration-(--duration-fast) group-data-panel-open/advanced:rotate-90" />
          {t('agents.advanced')}
        </CollapsibleTrigger>
        <CollapsibleContent className={PANEL}>
          <div className="flex flex-col pt-1 [&>*+*]:border-t [&>*+*]:border-border-soft">
            <RowFrame
              first
              text={
                <RowText
                  name={t('agents.launch')}
                  description={
                    <code className="font-mono text-[11.5px] break-all" data-selectable="">
                      {status.launchCommand}
                    </code>
                  }
                />
              }
            >
              <CopyButton text={status.launchCommand} label={t('agents.copyLaunch')} />
            </RowFrame>
            {status.package && (
              <RowFrame
                first
                text={
                  <RowText
                    name={t('agents.adapter')}
                    description={
                      <span className="flex flex-wrap gap-x-1.5">
                        <code className="font-mono text-[11.5px] break-all" data-selectable="">
                          {status.package.name}@{status.package.version}
                        </code>
                        {!status.package.installed && r.kind !== 'installing' && (
                          <span>{t('agents.installsOnFirstUse')}</span>
                        )}
                      </span>
                    }
                  />
                }
              >
                {status.package.installed && (
                  <Button
                    variant="quiet"
                    size="compact"
                    disabled={busy || r.kind === 'installing' || r.kind === 'starting'}
                    onClick={() => act(() => host('agents.reinstall', { agentId: status.id }))}
                  >
                    {busy ? (
                      <Spinner data-icon="inline-start" className="size-3" />
                    ) : (
                      <DownloadIcon data-icon="inline-start" />
                    )}
                    {t('agents.reinstall')}
                  </Button>
                )}
              </RowFrame>
            )}
            {status.id !== 'opencode' && environment?.nodeVersion && (
              <Fact name="Node.js" mono>
                {environment.nodeVersion}
              </Fact>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** A titled run of rows on an agent's page, a hairline between each. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-ui font-semibold">{title}</h3>
      <div className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border-soft">{children}</div>
    </section>
  )
}

/** A name and its value; "Not reported" while the agent has not said. */
function Fact({ name, mono, children }: { name: string; mono?: boolean; children: ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame first text={<RowText name={name} />}>
      {children ? (
        <span className={cn('text-ui', mono && 'font-mono text-[12.5px]')} data-selectable="">
          {children}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t('agents.notReported')}</span>
      )}
    </RowFrame>
  )
}

function ConfigRow({ item }: { item: AgentConfigItem }) {
  const { t } = useTranslation('settings')
  const [error, setError] = useState<string | null>(null)
  return (
    <RowFrame
      first
      text={
        <RowText
          name={t(`agents.config.${item.id}`)}
          description={
            <span className="flex flex-wrap gap-x-1.5">
              <code className="font-mono text-[11.5px] break-all" data-selectable="">
                {item.path}
              </code>
              {item.env && <span>{t('agents.setBy', { env: item.env })}</span>}
            </span>
          }
        />
      }
    >
      <ControlError error={error} />
      {item.exists ? (
        <Button
          variant="quiet"
          size="compact"
          onClick={() =>
            window.overbench.shell
              .showItem(item.path)
              .catch((e: unknown) => setError(errorMessage(e)))
          }
        >
          <FolderOpenIcon data-icon="inline-start" />
          {t('agents.showIn', { name: fileManagerName() })}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{t('agents.notCreated')}</span>
      )}
    </RowFrame>
  )
}

/** The agent's mark and name as the page's title, opening a searchable list of the agents. */
function AgentPicker({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const { contains } = useComboboxFilter()
  const name = (id: AgentId) => agents.find((a) => a.id === id)?.name ?? id
  return (
    <Combobox
      items={agents.map((a) => a.id)}
      value={status.id}
      onValueChange={(id: AgentId | null) => {
        if (id) openAgentSettings(id)
      }}
      itemToStringLabel={name}
      filter={(id: AgentId, query: string) => contains(name(id), query)}
    >
      <h2 className="flex min-w-0">
        <ComboboxTrigger className="-ml-1 flex min-w-0 items-center gap-3 rounded-lg py-1 pr-2.5 pl-1 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-muted/60">
          <AgentTile agent={status.id} mono={!isInstalled(status)} />
          <span className="truncate text-[22px] font-semibold tracking-[-0.015em]">
            {status.name}
          </span>
        </ComboboxTrigger>
      </h2>
      <ComboboxContent className="w-72">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('agents.search')}
          aria-label={t('agents.search')}
          spellCheck={false}
        />
        <ComboboxEmpty>{t('agents.noMatch')}</ComboboxEmpty>
        <ComboboxList>
          {(id: AgentId) => {
            const agent = agents.find((a) => a.id === id)
            return (
              agent && (
                <ComboboxItem key={id} value={id}>
                  <AgentMark agent={id} size={14} mono={!isInstalled(agent)} />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <AgentStateLine status={agent} className="shrink-0 text-muted-foreground" />
                </ComboboxItem>
              )
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export function EnvironmentFooter() {
  const { t } = useTranslation('settings')
  const environment = useAgentsStore((s) => s.environment)
  const now = useNow()
  const [act, busy, error] = useAction()
  const source = environment?.source
  const text =
    !environment || source === 'pending'
      ? t('agents.environment.pending')
      : source === 'login-shell'
        ? environment.shell && environment.resolvedAt && environment.durationMs
          ? t('agents.environment.loginShell', {
              shell: environment.shell,
              ago: longAgo(environment.resolvedAt, now),
              ms: environment.durationMs,
            })
          : t('agents.environment.loginShellPlain')
        : source === 'inherited'
          ? t('agents.environment.inherited')
          : t('agents.environment.fallback')
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
          {t('agents.environment.reload')}
        </Button>
      </div>
      {environment?.warning && <p className="text-xs text-attention-text">{environment.warning}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
