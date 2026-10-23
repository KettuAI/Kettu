import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleArrowUpIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  LogOutIcon,
  RefreshCwIcon,
  RotateCwIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentConfigItem,
  AgentInstallMethod,
  AgentStatus,
  AgentTask,
  PlanLimit,
} from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
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
import { Separator } from '@renderer/components/ui/separator'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { listedInstalled, readiness } from '@renderer/features/agents/readiness'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { countdown, usageTone } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo, resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
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
import {
  ControlError,
  CopyAction,
  IconAction,
  Masked,
  PathText,
  RevealAction,
  SettingSelect,
} from './controls'
import { GroupLabel, RowFrame, RowShell, RowText } from './rows'
import { useApply } from './use-apply'

const VENDORS: Partial<Record<AgentId, string>> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'SST',
}

/** A check the user started counts as just done for this long, then it reads as "checked ago". */
const JUST_CHECKED_MS = 60_000

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

/** The way OverBench would install it now, or null when it cannot. */
function installMethod(status: AgentStatus, picked?: string): AgentInstallMethod | null {
  const available = status.installMethods.filter((m) => m.available)
  return available.find((m) => m.id === picked) ?? available[0] ?? null
}

function canInstall(status: AgentStatus): boolean {
  if (status.package) return !status.package.installed && status.state === 'available'
  return status.state === 'not-installed' && installMethod(status) !== null
}

function startInstall(agentId: AgentId, method?: AgentInstallMethod['id'] | null): void {
  void useAgentsStore.getState().install(agentId, method ?? undefined)
}

function startUpdate(agentId: AgentId): void {
  void useAgentsStore.getState().update(agentId)
}

function cancelTask(agentId: AgentId): void {
  void useAgentsStore.getState().cancelTask(agentId)
}

/** Runs a failed task again, by the route it took. */
function retryTask(agentId: AgentId, task: AgentTask): void {
  if (task.kind === 'update') startUpdate(agentId)
  else startInstall(agentId, task.method)
}

/** The small x inside a pill that cancels its task or dismisses its failure. */
function PillClose({
  label,
  tone,
  onClick,
}: {
  label: string
  tone: 'info' | 'error'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-4 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        tone === 'info' ? 'hover:bg-checked-tint-hover' : 'hover:bg-destructive-tint-hover',
      )}
    >
      <XIcon className="size-2.5" />
    </button>
  )
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
  // Again on each state or task change, so an adapter installed or updated shows its CLI version.
  const task = status.task?.state ?? null
  useEffect(() => {
    useAgentsStore
      .getState()
      .loadDetails(status.id)
      .catch((e: unknown) => console.warn(`Could not read the agent details: ${errorMessage(e)}`))
  }, [status.id, status.state, task])
  return reading
}

/** The windows whose reset has not passed; an older reading of them no longer holds. */
function currentLimits(limits: PlanLimit[], now: number): PlanLimit[] {
  return limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
}

/** The agent's own version: for a package agent the CLI its adapter runs, never the adapter's. */
function useAgentVersion(status: AgentStatus): string | null {
  const details = useAgentsStore((s) => s.details[status.id])
  if (status.cli?.runs === 'installed') return status.cli.installed?.version ?? null
  return details?.cliVersion ?? (status.package ? null : status.version)
}

const TONE_TEXT = { success: '', attention: 'text-attention-text', destructive: 'text-destructive' }

function percent(limit: PlanLimit): string {
  return limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`
}

/** What an agent's row offers next to its name: install, update, or how either is going. */
function AgentPill({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const version = useAgentVersion(status)
  const task: AgentTask | null = status.task
  if (task?.state === 'running' || status.state === 'installing') {
    const updating = task?.kind === 'update'
    return (
      <Badge variant="info" className="pr-1">
        <Spinner data-icon="inline-start" />
        {t(updating ? 'agents.update.updating' : 'agents.install.installing')}
        {/* The host also stops a first-use install, which runs with no task of its own. */}
        {(task || status.package) && (
          <PillClose
            label={t(updating ? 'agents.update.cancel' : 'agents.install.cancel')}
            tone="info"
            onClick={() => cancelTask(status.id)}
          />
        )}
      </Badge>
    )
  }
  if (task?.state === 'failed') {
    const updating = task.kind === 'update'
    return (
      <Badge variant="error" className="pr-1 has-[[data-retry]:hover]:bg-destructive-tint-hover">
        <button
          type="button"
          data-retry=""
          title={task.error ?? undefined}
          onClick={() => retryTask(status.id, task)}
          className="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <RotateCwIcon className="size-3" />
          {t(updating ? 'agents.update.failed' : 'agents.install.failed')}
        </button>
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(status.id)}
        />
      </Badge>
    )
  }
  if (taskError) {
    return (
      <Badge variant="error" className="pr-1" title={taskError.message}>
        <CircleAlertIcon data-icon="inline-start" />
        {t(
          taskError.kind === 'update' ? 'agents.update.failedTitle' : 'agents.install.failedTitle',
        )}
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(status.id)}
        />
      </Badge>
    )
  }
  if (status.update) {
    const next = status.update.cliVersion
    const shown = next && next !== version ? next : null
    return (
      <Badge
        variant="info"
        render={
          <button
            type="button"
            title={t('agents.update.adapterVersion', {
              name: status.package?.name ?? status.name,
              version: status.update.adapterVersion,
            })}
            onClick={() => startUpdate(status.id)}
          />
        }
      >
        <CircleArrowUpIcon data-icon="inline-start" />
        {t('agents.update.available')}
        {shown && <span className="font-mono text-meta font-normal">{shown}</span>}
      </Badge>
    )
  }
  if (updated) {
    return (
      <Badge variant="success">
        <CircleCheckIcon data-icon="inline-start" />
        {t('agents.update.done')}
      </Badge>
    )
  }
  if (canInstall(status)) {
    const method = installMethod(status)
    return (
      <Badge
        variant="info"
        render={
          <button
            type="button"
            title={
              method ? t('agents.install.through', { method: methodName(t, method) }) : undefined
            }
            onClick={() => startInstall(status.id)}
          />
        }
      >
        <DownloadIcon data-icon="inline-start" />
        {t('agents.install.button')}
      </Badge>
    )
  }
  return null
}

type SettingsT = ReturnType<typeof useTranslation<'settings'>>['t']

function methodName(t: SettingsT, method: AgentInstallMethod): string {
  return t(`agents.install.methods.${method.id}`)
}

/** One agent in the list on the Agents page: what it is, who it is signed in as, its usage. */
export function AgentListItem({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const details = useAgentsStore((s) => s.details[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const now = useNow()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const version = useAgentVersion(status)
  const installed = listedInstalled(status)
  const account = status.account?.kind === 'none' ? null : status.account
  const limits = currentLimits(status.limits, now)
  const method = installMethod(status)
  const folder = details?.config.find((item) => item.id === 'folder')?.path
  // What it needs first; then who it is signed in as; else how it runs or where it is set up.
  const summary: ReactNode =
    status.task?.state === 'running' ? (
      (status.task.progress.at(-1) ?? null)
    ) : status.state === 'installing' ? (
      (status.progress.at(-1) ?? t('agents.install.installing'))
    ) : status.task?.state === 'failed' ? (
      <span className="text-destructive">{status.task.error}</span>
    ) : taskError ? (
      <span className="text-destructive">{taskError.message}</span>
    ) : !installed && canInstall(status) ? (
      status.package ? (
        t('agents.install.missingLineAdapter')
      ) : (
        method && t('agents.install.missingLine', { method: methodName(t, method) })
      )
    ) : r.kind === 'missing' || r.kind === 'failed' ? (
      r.message
    ) : r.kind === 'sign-in' ? (
      t('agents.needsSignIn', { name: status.name })
    ) : account ? (
      <>
        {account.label}
        {account.email && (
          <>
            {' · '}
            <span className="text-foreground">
              <Masked>{account.email}</Masked>
            </span>
          </>
        )}
      </>
    ) : reading && status.capabilities.account ? (
      t('agents.readingAccount')
    ) : folder ? (
      <PathText path={folder} />
    ) : null
  const usage = !installed ? null : limits.length > 0 ? (
    <UsageMeters limits={limits} />
  ) : status.capabilities.reports ? (
    <span className="text-xs text-muted-foreground">
      {t(reading ? 'agents.readingUsage' : 'agents.usageOnceRunning')}
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">{t('agents.noUsage')}</span>
  )
  return (
    <div className="relative -mx-2 rounded-lg px-3 py-3 transition-colors duration-(--duration-fast) has-[>[data-row-hit]:hover]:bg-accent">
      {/* Buttons cannot nest, so the row opens through a button laid under its content. */}
      <button
        type="button"
        data-row-hit=""
        aria-label={status.name}
        onClick={() => openAgentSettings(status.id)}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <div className="pointer-events-none relative flex items-start gap-3">
        <AgentTile agent={status.id} mono={!installed} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex h-5 min-w-0 items-center gap-2">
            <span className="truncate text-ui font-medium">{status.name}</span>
            {version && (
              <span className="shrink-0 font-mono text-meta text-muted-foreground">{version}</span>
            )}
            <span className="pointer-events-auto flex shrink-0">
              <AgentPill status={status} />
            </span>
          </div>
          {summary && (
            <span className="truncate text-xs leading-normal text-muted-foreground">{summary}</span>
          )}
          {usage}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-2">
          {installed && <AgentStateLine status={status} />}
          <ChevronRightIcon className="size-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  )
}

/** Up to two current windows, each a label, its percentage, the time left and a bar. */
function UsageMeters({ limits }: { limits: PlanLimit[] }) {
  const { t } = useTranslation(['settings', 'composer'])
  const now = useNow()
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-5">
      {limits.slice(0, 2).map((limit) => {
        const left = limit.resetsAt ? countdown(limit.resetsAt - now) : null
        const tone = usageTone(limit)
        return (
          <div key={limit.window} className="flex min-w-0 flex-col gap-1.5 text-xs tabular">
            <div className="flex items-baseline gap-1.5">
              <span className="text-muted-foreground">{limitLabel(limit)}</span>
              <span className={cn('font-medium', TONE_TEXT[tone])}>{percent(limit)}</span>
              {left && (
                <span className="ml-auto truncate text-muted-foreground">
                  {t('agents.resetsIn', { time: left })}
                </span>
              )}
            </div>
            <Progress
              value={limit.usedPercent ?? 0}
              tone={tone}
              aria-label={t('composer:usage.limits.used', { limit: limitLabel(limit) })}
            />
          </div>
        )
      })}
    </div>
  )
}

/** The Installed group's own actions: check for updates, and hide the account details. */
export function AgentsGroupActions() {
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [apply, error] = useApply()
  const now = useNow()
  const checkable = agents.some((a) => a.package)
  const lastAt = Math.max(0, ...agents.map((a) => a.updateCheckedAt ?? 0)) || null
  const pending = agents.filter((a) => a.update).length
  const meta: ReactNode = check.running ? null : check.error ? (
    <span className="text-destructive" title={check.error}>
      {t('agents.update.checkFailed')}
    </span>
  ) : check.finishedAt && now - check.finishedAt < JUST_CHECKED_MS ? (
    pending > 0 ? (
      t('agents.update.justChecked', { count: pending })
    ) : (
      t('agents.update.allCurrent')
    )
  ) : lastAt ? (
    t('agents.update.checkedAgo', { ago: longAgo(lastAt, now) })
  ) : null
  return (
    <>
      {meta && <span className="mr-1 text-muted-foreground">{meta}</span>}
      {checkable && (
        <Button
          variant="quiet"
          size="xs"
          disabled={check.running}
          onClick={() => void useAgentsStore.getState().checkUpdates()}
        >
          {check.running ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          {t('agents.update.check')}
        </Button>
      )}
      {checkable && <Separator orientation="vertical" className="mx-0.5 h-3 self-center" />}
      <ControlError error={error} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="xs"
              aria-pressed={hidden}
              onClick={() => apply({ privacy: { hideAccount: !hidden } })}
            />
          }
        >
          {hidden ? <EyeIcon data-icon="inline-start" /> : <EyeOffIcon data-icon="inline-start" />}
          {t(hidden ? 'agents.showAccounts' : 'agents.hideAccounts')}
        </TooltipTrigger>
        <TooltipContent>{t('agents.hideAccountsHint')}</TooltipContent>
      </Tooltip>
    </>
  )
}

/** An agent's own page: its version, account, usage, configuration and how it launches. */
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
      className="-ml-1.5 mb-3 w-max px-1.5"
      onClick={() => openAgentSettings(null)}
    >
      <ArrowLeftIcon data-icon="inline-start" />
      {t('sections.agents')}
    </Button>
  )
}

function AgentPageBody({ status }: { status: AgentStatus }) {
  const { t } = useTranslation(['settings', 'common'])
  const environment = useAgentsStore((s) => s.environment)
  const override = useSettingsStore((s) => s.settings.agents[status.id]?.binaryPath)
  const [act, busy, error] = useAction()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const version = useAgentVersion(status)
  const installed = listedInstalled(status)
  const running = status.state === 'ready'
  const adapter = status.package?.name.split('/').at(-1)
  const vendor = VENDORS[status.id]
  const connection = vendor
    ? adapter
      ? t('agents.via', { vendor, adapter })
      : t('agents.direct', { vendor })
    : null

  const signInTerminal = (command: string) => {
    const view = useViewStore.getState()
    const projectPath = view.projectPath ?? useProjectsStore.getState().projects[0]?.path
    if (!projectPath) return
    closeSettings()
    toggleTerminal(projectPath, true)
    emitAppEvent({ kind: 'sign-in-terminal', projectPath, command, agentId: status.id })
  }

  return (
    <div className="flex flex-col">
      <BackToAgents />
      <header className="flex items-center gap-3 px-1 pb-7">
        <AgentTile agent={status.id} mono={!installed} size={40} glyph={21} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="flex min-w-0 text-title font-semibold">
            <AgentPicker status={status} />
          </h2>
          <p className="flex items-center gap-2 text-small text-muted-foreground">
            {installed && <AgentStateLine status={status} />}
            {connection}
          </p>
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
                <Spinner data-icon="inline-start" />
              ) : (
                <RotateCwIcon data-icon="inline-start" />
              )}
              {t('common:actions.retry')}
            </Button>
          )}
          {r.kind === 'missing' && !canInstall(status) && r.url && (
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
      </header>

      <div className="flex flex-col gap-7">
        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="-mt-4 px-1 text-xs text-attention-text" data-selectable="">
            {status.detail}
          </p>
        )}
        {(r.kind === 'failed' || (r.kind === 'missing' && !canInstall(status))) && (
          <p
            className={cn(
              '-mt-4 px-1 text-xs',
              r.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
            data-selectable=""
          >
            {r.message}
          </p>
        )}
        {r.kind === 'sign-in' && status.authMethods.length > 0 && (
          <Alert variant="warning">
            <AlertTitle>{t('agents.needsSignIn', { name: status.name })}</AlertTitle>
            <AlertDescription className="mt-2 flex flex-wrap gap-1.5">
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
            </AlertDescription>
          </Alert>
        )}
        {error && <p className="-mt-4 px-1 text-xs text-destructive">{error}</p>}

        <TaskNotice status={status} version={version} installed={installed} />
        {!installed && <InstallNotice status={status} />}

        {installed && <VersionGroup status={status} version={version} />}

        {installed && (
          <section className="flex flex-col">
            <GroupLabel group={{ id: 'account', label: t('agents.account') }} />
            {/* A subscription's label is its plan; the other kinds name how the agent signs in. */}
            <Fact
              name={t(status.account?.kind === 'account' ? 'agents.plan' : 'agents.loginMethod')}
            >
              {status.account?.label}
            </Fact>
            {status.account?.email && (
              <Fact name={t('agents.email')}>
                <Masked>{status.account.email}</Masked>
              </Fact>
            )}
          </section>
        )}

        {installed && <UsageGroup status={status} reading={reading} running={running} />}

        <section className="flex flex-col">
          <GroupLabel group={{ id: 'configuration', label: t('agents.configuration') }} />
          <ConfigRows status={status} override={override ?? null} />
        </section>

        {installed && (
          <Collapsible>
            <CollapsibleTrigger className="group/advanced flex h-7.5 w-full items-center gap-1 px-1 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              <ChevronRightIcon className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/advanced:rotate-90" />
              {t('agents.advanced')}
            </CollapsibleTrigger>
            <CollapsibleContent className={PANEL}>
              <RowFrame
                text={
                  <RowText
                    name={t('agents.launch')}
                    description={
                      <code className="font-mono text-meta break-all" data-selectable="">
                        {status.launchCommand}
                      </code>
                    }
                  />
                }
              >
                <CopyAction text={status.launchCommand} label={t('agents.copyLaunch')} />
              </RowFrame>
              {status.package && (
                <RowFrame
                  text={
                    <RowText
                      name={t('agents.adapter')}
                      description={
                        <code className="font-mono text-meta break-all" data-selectable="">
                          {status.package.name}@{status.package.version}
                        </code>
                      }
                    />
                  }
                >
                  {status.package.installed && (
                    <Button
                      variant="outline"
                      size="compact"
                      disabled={busy || r.kind === 'installing' || r.kind === 'starting'}
                      onClick={() => act(() => host('agents.reinstall', { agentId: status.id }))}
                    >
                      {busy && <Spinner data-icon="inline-start" />}
                      {t('agents.reinstall')}
                    </Button>
                  )}
                </RowFrame>
              )}
              {status.package && environment?.nodeVersion && (
                <Fact name="Node.js" mono>
                  {environment.nodeVersion}
                </Fact>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  )
}

/** The agent's version, whether a newer one exists, and the check for it. */
function VersionGroup({ status, version }: { status: AgentStatus; version: string | null }) {
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const now = useNow()
  const checkedAt = status.updateCheckedAt
  const updating = status.task?.kind === 'update' && status.task.state === 'running'
  const line: ReactNode = !status.package ? null : check.running ? (
    t('agents.update.checking')
  ) : updating ? (
    t('agents.update.updating')
  ) : (
    <>
      <span
        aria-hidden
        className={cn(
          'mr-1.5 inline-block size-1.5 rounded-full align-[0.1em]',
          status.update ? 'bg-checked' : 'bg-success',
        )}
      />
      {status.update
        ? t('agents.update.released', {
            version: status.update.cliVersion ?? status.update.adapterVersion,
          })
        : t('agents.update.upToDate')}
      {' · '}
      {checkedAt
        ? t('agents.update.checkedAgo', { ago: longAgo(checkedAt, now) })
        : t('agents.update.notChecked')}
    </>
  )
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'version', label: t('agents.versionGroup') }} />
      <RowFrame
        text={
          <RowText
            name={
              <span className="flex items-baseline gap-2">
                {t('agents.currentVersion')}
                <span className="font-mono text-meta font-normal text-muted-foreground">
                  {version ?? t('agents.notReported')}
                </span>
              </span>
            }
            description={line}
          />
        }
      >
        {status.package && (
          <Button
            variant="outline"
            size="compact"
            disabled={check.running || updating}
            onClick={() => void useAgentsStore.getState().checkUpdates()}
          >
            {check.running ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {t('agents.update.check')}
          </Button>
        )}
      </RowFrame>
    </section>
  )
}

/** An update on offer, under way, failed or just done, in one notice under the page's title. */
function TaskNotice({
  status,
  version,
  installed,
}: {
  status: AgentStatus
  version: string | null
  installed: boolean
}) {
  const { t } = useTranslation(['settings', 'common'])
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  // An install of an agent that is not installed shows in its install notice instead.
  const task = status.task && (status.task.kind === 'update' || installed) ? status.task : null
  const updating = task?.kind === 'update'
  if (task?.state === 'running') {
    return (
      <Alert variant="info">
        <Spinner />
        <AlertTitle>
          {t(updating ? 'agents.update.progressTitle' : 'agents.install.progressTitle', {
            name: status.name,
          })}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2.5">
          <span className="truncate">{task.progress.at(-1) ?? task.command}</span>
          <TaskLog task={task} />
          <span>
            <Button variant="outline" size="compact" onClick={() => cancelTask(status.id)}>
              {t(updating ? 'agents.update.cancel' : 'agents.install.cancel')}
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    )
  }
  if (task?.state === 'failed') {
    return <FailedTaskNotice status={status} task={task} />
  }
  if (taskError && !status.task) {
    return (
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertTitle>
          {t(
            taskError.kind === 'update'
              ? 'agents.update.failedTitle'
              : 'agents.install.failedTitle',
          )}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2.5">
          <span data-selectable="">{taskError.message}</span>
          <span>
            <Button variant="quiet" size="compact" onClick={() => cancelTask(status.id)}>
              {t('agents.task.dismiss')}
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    )
  }
  if (status.update) {
    const next = status.update.cliVersion
    return (
      <Alert variant="info">
        <CircleArrowUpIcon />
        <AlertTitle>
          {next && next !== version
            ? t('agents.update.noticeTitle', { name: status.name, version: next })
            : t('agents.update.noticeTitleAdapter', { name: status.name })}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2.5">
          <span>
            {t('agents.update.noticeBody', {
              current: version ?? status.package?.version ?? '',
              name: status.name,
            })}
          </span>
          <span>
            <Button size="compact" onClick={() => startUpdate(status.id)}>
              <DownloadIcon data-icon="inline-start" />
              {t('agents.update.button')}
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    )
  }
  if (updated) {
    return (
      <Alert variant="success">
        <CircleCheckIcon />
        <AlertTitle>{t('agents.update.doneTitle', { name: status.name })}</AlertTitle>
        <AlertDescription>{t('agents.update.doneBody', { name: status.name })}</AlertDescription>
      </Alert>
    )
  }
  return null
}

/** A failed install or update: why, its log, and retry, copy or dismiss. */
function FailedTaskNotice({ status, task }: { status: AgentStatus; task: AgentTask }) {
  const { t } = useTranslation(['settings', 'common'])
  const updating = task.kind === 'update'
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertTitle>
        {t(updating ? 'agents.update.failedTitle' : 'agents.install.failedTitle')}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2.5">
        {updating ? (
          <span>{t('agents.update.failedBody')}</span>
        ) : (
          task.error && <span data-selectable="">{task.error}</span>
        )}
        <TaskLog task={task} />
        <span className="flex flex-wrap gap-1.5">
          <Button size="compact" onClick={() => retryTask(status.id, task)}>
            <RotateCwIcon data-icon="inline-start" />
            {t('common:actions.retry')}
          </Button>
          <LogCopyButton task={task} />
          <Button variant="quiet" size="compact" onClick={() => cancelTask(status.id)}>
            {t('agents.task.dismiss')}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}

/** Installing an agent that is not installed: how, then its progress, then why it failed. */
function InstallNotice({ status }: { status: AgentStatus }) {
  const { t } = useTranslation(['settings', 'common'])
  const task = status.task?.kind === 'install' ? status.task : null
  const [picked, setPicked] = useState<string | undefined>(task?.method ?? undefined)
  const method = installMethod(status, picked)
  if (task?.state === 'running' || status.state === 'installing') {
    const lines = task ? task.progress : status.progress
    return (
      <Alert variant="info">
        <Spinner />
        <AlertTitle>{t('agents.install.progressTitle', { name: status.name })}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2.5">
          <span className="truncate">{lines.at(-1) ?? task?.command}</span>
          {lines.length > 0 && <Log lines={lines} />}
          {(task || status.package) && (
            <span>
              <Button variant="outline" size="compact" onClick={() => cancelTask(status.id)}>
                {t('agents.install.cancel')}
              </Button>
            </span>
          )}
        </AlertDescription>
      </Alert>
    )
  }
  if (task?.state === 'failed') return <FailedTaskNotice status={status} task={task} />
  if (!canInstall(status)) return null
  return (
    <Alert variant="info">
      <DownloadIcon />
      <AlertTitle>{t('agents.install.title', { name: status.name })}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2.5">
        <span>
          {status.package && status.cli?.runs === 'installed' && status.cli.installed?.version
            ? t('agents.install.adapterBodyCli', {
                package: status.package.name,
                command: status.cli.command,
                version: status.cli.installed.version,
                name: status.name,
              })
            : status.package
              ? t('agents.install.adapterBody', { package: status.package.name })
              : t('agents.install.body')}
        </span>
        {!status.package && (
          <span className="flex items-center gap-3">
            <span>{t('agents.install.method')}</span>
            <SettingSelect
              label={t('agents.install.method')}
              value={method?.id ?? ''}
              options={status.installMethods.map((m) => ({
                value: m.id,
                label: methodName(t, m),
                hint: m.available ? undefined : t('agents.install.notFound'),
                disabled: !m.available,
              }))}
              onChange={(id) => setPicked(id)}
            />
          </span>
        )}
        {method && (
          <code
            className="block truncate rounded-lg bg-card px-3 py-2 font-mono text-code text-foreground"
            data-selectable=""
            title={method.command}
          >
            {method.command}
          </code>
        )}
        <span className="flex flex-wrap gap-1.5">
          <Button size="compact" onClick={() => startInstall(status.id, method?.id)}>
            <DownloadIcon data-icon="inline-start" />
            {t('agents.install.button')}
          </Button>
          {!status.package && (
            <Button
              variant="quiet"
              size="compact"
              onClick={() =>
                void window.overbench.dialogs
                  .chooseAgentBinary(status.id)
                  .catch((e: unknown) => console.warn(errorMessage(e)))
              }
            >
              {t('agents.install.elsewhere')}
            </Button>
          )}
        </span>
      </AlertDescription>
    </Alert>
  )
}

function TaskLog({ task }: { task: AgentTask }) {
  const lines = task.progress.length > 0 ? task.progress : [task.command]
  return <Log lines={lines} error={task.state === 'failed'} />
}

function Log({ lines, error }: { lines: string[]; error?: boolean }) {
  return (
    <pre
      data-selectable=""
      className={cn(
        'max-h-40 overflow-auto rounded-lg bg-card px-3 py-2 font-mono text-meta whitespace-pre-wrap',
        error ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {lines.join('\n')}
    </pre>
  )
}

function LogCopyButton({ task }: { task: AgentTask }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="quiet"
      size="compact"
      onClick={() => {
        const text = [`$ ${task.command}`, ...task.progress, task.error ?? ''].join('\n')
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {t('agents.install.copyLog')}
    </Button>
  )
}

/** Plan usage, one row per window, read afresh while the page shows. */
function UsageGroup({
  status,
  reading,
  running,
}: {
  status: AgentStatus
  reading: boolean
  running: boolean
}) {
  const { t } = useTranslation(['settings', 'composer'])
  const now = useNow()
  const [act, busy, error] = useAction()
  const observed = Math.max(0, ...status.limits.map((l) => l.observedAt)) || null
  const actions =
    status.limits.length > 0 && limitsReadable(status) ? (
      <>
        {observed && (
          <span className="text-muted-foreground">
            {t('agents.usageUpdated', { ago: longAgo(observed, now) })}
          </span>
        )}
        <IconAction
          label={t('agents.refreshUsage')}
          disabled={busy}
          onClick={() => act(() => refreshLimits(status.id))}
        >
          {busy ? <Spinner /> : <RefreshCwIcon />}
        </IconAction>
      </>
    ) : null
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'usage', label: t('agents.usage'), actions }} />
      {status.limits.length > 0 ? (
        status.limits.map((limit) => {
          const tone = usageTone(limit)
          const left = limit.resetsAt ? countdown(limit.resetsAt - now) : null
          return (
            <RowFrame
              key={limit.window}
              text={
                <RowText
                  name={limitLabel(limit)}
                  description={
                    limit.resetsAt
                      ? left
                        ? t('agents.resetsIn', { time: left })
                        : t('agents.resetsAt', { time: resetTime(limit.resetsAt, now) })
                      : undefined
                  }
                />
              }
            >
              <Progress
                value={limit.usedPercent ?? 0}
                tone={tone}
                className="w-40"
                aria-label={t('composer:usage.limits.used', { limit: limitLabel(limit) })}
              />
              <span
                className={cn('w-10 text-right text-small font-medium tabular', TONE_TEXT[tone])}
              >
                {percent(limit)}
              </span>
            </RowFrame>
          )
        })
      ) : reading && status.capabilities.reports ? (
        <RowShell>
          <p className="py-3 text-xs text-muted-foreground">{t('agents.readingUsage')}</p>
        </RowShell>
      ) : limitsReadable(status) && !running ? (
        <RowFrame text={<RowText name={t('agents.planLimits')} />}>
          <ControlError error={error} />
          <Button
            variant="outline"
            size="compact"
            disabled={busy}
            onClick={() => act(() => refreshLimits(status.id))}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t('agents.checkLimits')}
          </Button>
        </RowFrame>
      ) : (
        <RowShell>
          <p className="py-3 text-xs text-muted-foreground">
            {t('agents.usageNotReported', { name: status.name })}
          </p>
        </RowShell>
      )}
      {error && status.limits.length > 0 && (
        <p className="px-1 pt-1 text-xs text-destructive">{error}</p>
      )}
    </section>
  )
}

/** A name and its value; "Not reported" while the agent has not said. */
function Fact({ name, mono, children }: { name: string; mono?: boolean; children: ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame text={<RowText name={name} />}>
      {children ? (
        <span className={cn('text-ui', mono && 'font-mono text-meta')} data-selectable="">
          {children}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t('agents.notReported')}</span>
      )}
    </RowFrame>
  )
}

function ConfigRows({ status, override }: { status: AgentStatus; override: string | null }) {
  const { t } = useTranslation('settings')
  const details = useAgentsStore((s) => s.details[status.id])
  const [act, , error] = useAction()
  return (
    <>
      {status.id === 'opencode' && (
        <RowFrame
          text={
            <RowText
              name={t('agents.program')}
              description={override ? <PathText path={override} /> : t('agents.programOnPath')}
            />
          }
        >
          <ControlError error={error} />
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
      {details?.config.map((item) => (
        <ConfigRow key={item.id} item={item} />
      ))}
      {details && details.config.length === 0 && status.id !== 'opencode' && (
        <RowShell>
          <p className="py-3 text-xs text-muted-foreground">{t('agents.noConfig')}</p>
        </RowShell>
      )}
    </>
  )
}

function ConfigRow({ item }: { item: AgentConfigItem }) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame
      text={
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-ui font-medium">{t(`agents.config.${item.id}`)}</span>
          <PathText path={item.path} missing={!item.exists} />
          {item.env && (
            <span className="text-xs text-muted-foreground">
              {t('agents.setBy', { env: item.env })}
            </span>
          )}
        </div>
      }
    >
      {item.exists ? (
        <>
          <CopyAction text={item.path} label={t('advanced.dataFolder.copy')} />
          <RevealAction path={item.path} />
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{t('agents.notCreated')}</span>
      )}
    </RowFrame>
  )
}

/** The agent's name as the page's title, opening a searchable list of the agents. */
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
      <ComboboxTrigger className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-accent">
        <span className="truncate">{status.name}</span>
      </ComboboxTrigger>
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
    <div className="flex flex-col gap-1 px-1 pt-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            source === 'login-shell' ? 'bg-success' : 'bg-muted-foreground',
          )}
        />
        <span className="min-w-0 flex-1">{text}</span>
        <Button
          variant="quiet"
          size="xs"
          disabled={busy}
          onClick={() => act(() => useAgentsStore.getState().reloadEnvironment())}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {t('agents.environment.reload')}
        </Button>
      </div>
      {environment?.warning && <p className="text-xs text-attention-text">{environment.warning}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
