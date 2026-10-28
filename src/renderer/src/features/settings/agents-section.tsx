import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
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
  LogInIcon,
  RotateCwIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentCli,
  AgentCliSource,
  AgentConfigItem,
  AgentInstallMethod,
  AgentStatus,
  AgentTask,
  PlanLimit,
} from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
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
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { listedInstalled, readiness } from '@renderer/features/agents/readiness'
import { adapterOnlyUpdate } from '@renderer/features/agents/updates'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { countdown, USAGE_TONE_TEXT, usageTone } from '@renderer/features/sidebar/plan-usage'
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
import { configFolderChoice, type ConfigFolderMode } from './config-folder'
import {
  ControlError,
  CopyAction,
  GROUP_ACTION,
  IconAction,
  Masked,
  PathText,
  Segmented,
  SettingSelect,
} from './controls'
import { ConfigNote, ConfigPath, PathActions, PathLine } from './places'
import {
  FlashMark,
  GroupLabel,
  ItemPageHeader,
  ItemRow,
  Notice,
  RowFrame,
  RowGroup,
  RowShell,
  RowText,
} from './rows'
import { environmentText } from './environment-text'
import { useApply } from './use-apply'

const VENDORS: Partial<Record<AgentId, string>> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'SST',
  pi: 'Earendil',
  omp: 'Oh My Pi',
  hermes: 'Nous Research',
  muse: 'Meta',
  codewhale: 'Codewhale',
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

/**
 * Checks every package agent for updates. The store records a failure as `updateCheck.error`, so
 * reject as well, which keeps a failed check from showing the icon's check.
 */
async function checkForAgentUpdates(): Promise<void> {
  await useAgentsStore.getState().checkUpdates()
  const error = useAgentsStore.getState().updateCheck.error
  if (error) throw new Error(error)
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
        'grid size-4 place-items-center rounded-full outline-none focus-ring',
        tone === 'info' ? 'hover:bg-info-tint-hover' : 'hover:bg-destructive-tint-hover',
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
  }, [status.id, status.state, task, status.configDir?.runs])
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
  // A Claude Code or Codex row shows the CLI its adapter runs, never the adapter's version; an
  // agent that runs its own program (OpenCode, Pi) shows the version that program printed.
  return status.cli ? (details?.cliVersion ?? null) : status.version
}

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
          className="inline-flex items-center gap-1 rounded-sm outline-none focus-ring"
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
      <span className="text-danger">{status.task.error}</span>
    ) : taskError ? (
      <span className="text-danger">{taskError.message}</span>
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
            <span className="text-primary">
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
    <span className="text-xs text-tertiary">
      {t(reading ? 'agents.readingUsage' : 'agents.usageOnceRunning')}
    </span>
  ) : (
    <span className="text-xs text-tertiary">{t('agents.noUsage')}</span>
  )
  return (
    <ItemRow
      item={status.id}
      label={status.name}
      onOpen={() => openAgentSettings(status.id)}
      tile={<AgentTile agent={status.id} mono={!installed} size={30} glyph={16} />}
      name={
        <>
          <span className="truncate text-ui font-medium">{status.name}</span>
          {version && <span className="shrink-0 font-mono text-xs text-tertiary">{version}</span>}
          <span className="pointer-events-auto flex shrink-0">
            <AgentPill status={status} />
          </span>
        </>
      }
      right={
        installed && (
          <span className="pointer-events-auto flex">
            <AgentStateLine status={status} className="text-command" />
          </span>
        )
      }
    >
      {summary && (
        <span className="flex min-h-4.5 min-w-0 items-center text-command leading-4.5 text-secondary">
          <span className="min-w-0 truncate">{summary}</span>
        </span>
      )}
      {usage && <div className="mt-1.25 flex flex-wrap gap-x-5.5 gap-y-1">{usage}</div>}
    </ItemRow>
  )
}

/** Up to two current windows, each its label, a short bar, its percentage and the time left. */
function UsageMeters({ limits }: { limits: PlanLimit[] }) {
  const { t } = useTranslation(['settings', 'composer'])
  const now = useNow()
  return limits.slice(0, 2).map((limit) => {
    const left = limit.resetsAt ? countdown(limit.resetsAt - now) : null
    const tone = usageTone(limit)
    return (
      <span
        key={limit.window}
        className="inline-flex items-center gap-1.75 text-xs leading-4 text-tertiary tabular"
      >
        <span className="text-secondary">{limitLabel(limit)}</span>
        <Progress
          value={limit.usedPercent ?? 0}
          tone={tone}
          className="w-13"
          aria-label={t('composer:usage.limits.used', { limit: limitLabel(limit) })}
        />
        <span
          className={cn('min-w-6.5', tone !== 'success' && 'font-medium', USAGE_TONE_TEXT[tone])}
        >
          {percent(limit)}
        </span>
        {left && <span title={t('agents.resetsIn', { time: left })}>{left}</span>}
      </span>
    )
  })
}

/** The Installed group's own actions: check for updates, and hide the account details. */
export function AgentsGroupActions() {
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [apply, error] = useApply()
  const refresh = useRefresh({ busy: check.running })
  const now = useNow()
  const checkable = agents.some((a) => a.package)
  const lastAt = Math.max(0, ...agents.map((a) => a.updateCheckedAt ?? 0)) || null
  const pending = agents.filter((a) => a.update).length
  const meta: ReactNode =
    refresh.phase === 'turning' ? null : check.error ? (
      <span className="text-danger" title={check.error}>
        {t('agents.update.checkFailed')}
      </span>
    ) : check.finishedAt && now - check.finishedAt < JUST_CHECKED_MS ? (
      pending > 0 ? (
        t('agents.update.justChecked', { count: pending })
      ) : (
        t('agents.update.allCurrent')
      )
    ) : lastAt ? (
      pending > 0 ? (
        t('agents.update.checkedAgoUpdates', { ago: longAgo(lastAt, now), count: pending })
      ) : (
        t('agents.update.checkedAgo', { ago: longAgo(lastAt, now) })
      )
    ) : null
  return (
    <>
      {meta && <span className="mr-1 text-tertiary">{meta}</span>}
      {checkable && (
        <Button
          variant="quiet"
          size="sm"
          aria-busy={refresh.phase === 'turning'}
          disabled={refresh.phase === 'turning'}
          onClick={() => void refresh.run(checkForAgentUpdates).catch(() => {})}
          className={GROUP_ACTION}
        >
          <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
          {t('agents.update.check')}
        </Button>
      )}
      <ControlError error={error} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="sm"
              aria-pressed={hidden}
              onClick={() => apply({ privacy: { hideAccount: !hidden } })}
              className={cn(
                GROUP_ACTION,
                'aria-pressed:bg-transparent aria-pressed:text-primary aria-pressed:shadow-none aria-pressed:hover:bg-hover',
              )}
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
  if (!status) return <AgentPageHeader status={null} />
  return <AgentPageBody status={status} />
}

/** The page's header, without an agent once it is gone from the list. */
function AgentPageHeader({ status, actions }: { status: AgentStatus | null; actions?: ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <ItemPageHeader
      back={t('sections.agents')}
      onBack={() => openAgentSettings(null)}
      item={status?.id ?? 'agent'}
      icon={status && <AgentMark agent={status.id} size={22} mono={!listedInstalled(status)} />}
      title={status ? <AgentPicker status={status} /> : null}
      actions={actions}
    >
      {status && <AgentPageLine status={status} />}
    </ItemPageHeader>
  )
}

/** The line under an agent's title: its state and the CLI or vendor it runs through. */
function AgentPageLine({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const installed = listedInstalled(status)
  const adapter = status.package?.name.split('/').at(-1)
  const vendor = VENDORS[status.id]
  const connection = vendor
    ? adapter
      ? t('agents.via', { vendor, adapter })
      : t('agents.direct', { vendor })
    : null
  return (
    <p className="flex min-w-0 items-center gap-1.75 text-command leading-4.5 text-tertiary">
      {installed && <PageState status={status} />}
      {installed && connection && <span aria-hidden>·</span>}
      {connection && <span className="truncate">{connection}</span>}
    </p>
  )
}

/** The agent's state under its name: Ready in words here, as the list says it with a dot. */
function PageState({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('agents')
  if (readiness(status).kind !== 'ready') {
    return <AgentStateLine status={status} className="text-command" />
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-secondary">
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      {t('state.ready')}
    </span>
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

  const signInTerminal = (command: string) => {
    const view = useViewStore.getState()
    const projectPath = view.projectPath ?? useProjectsStore.getState().projects[0]?.path
    if (!projectPath) return
    closeSettings()
    toggleTerminal(projectPath, true)
    emitAppEvent({ kind: 'sign-in-terminal', projectPath, command, agentId: status.id })
  }

  const actions = (
    <>
      {r.kind === 'failed' && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(() => host('agents.retry', { agentId: status.id }))}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
          {t('common:actions.retry')}
        </Button>
      )}
      {r.kind === 'missing' && !canInstall(status) && r.url && (
        <a
          href={r.url}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {r.action}
          <ExternalLinkIcon data-icon="inline-end" />
        </a>
      )}
      {status.canLogout && status.signIn === 'signed-in' && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(() => host('agents.logout', { agentId: status.id }))}
        >
          {t('agents.signOut')}
        </Button>
      )}
    </>
  )

  return (
    <div className="flex flex-col">
      <AgentPageHeader status={status} actions={actions} />

      <div className="flex flex-col gap-7">
        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="-mt-4 px-1 text-xs text-secondary" data-selectable="">
            {status.detail}
          </p>
        )}
        {(r.kind === 'failed' || (r.kind === 'missing' && !canInstall(status))) && (
          <p
            className={cn(
              '-mt-4 px-1 text-xs',
              r.kind === 'failed' ? 'text-danger' : 'text-secondary',
            )}
            data-selectable=""
          >
            {r.message}
          </p>
        )}
        {r.kind === 'sign-in' && status.authMethods.length > 0 && (
          <SignInNotice
            status={status}
            busy={busy}
            onTerminal={signInTerminal}
            onAuthenticate={(methodId) =>
              act(() => host('agents.authenticate', { agentId: status.id, methodId }))
            }
          />
        )}
        {error && <p className="-mt-4 px-1 text-xs text-danger">{error}</p>}

        <TaskNotice status={status} version={version} installed={installed} />
        {!installed && <InstallNotice status={status} />}

        {installed && <VersionGroup status={status} version={version} />}

        {installed && (
          <section className="flex flex-col">
            <GroupLabel group={{ id: 'account', label: t('agents.account') }} />
            <RowGroup>
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
            </RowGroup>
          </section>
        )}

        {installed && <UsageGroup status={status} reading={reading} running={running} />}

        <section className="flex flex-col">
          <GroupLabel group={{ id: 'configuration', label: t('agents.configuration') }} />
          <RowGroup>
            <ConfigRows status={status} override={override ?? null} />
          </RowGroup>
        </section>

        {installed && (
          <Collapsible>
            <CollapsibleTrigger className="group/advanced flex h-7.5 w-full items-center gap-1 px-1 text-left text-xs font-medium text-tertiary outline-none hover:text-primary focus-ring">
              <ChevronRightIcon className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/advanced:rotate-90" />
              {t('agents.advanced')}
            </CollapsibleTrigger>
            <CollapsibleContent className={PANEL}>
              <div className="pb-1">
                <RowGroup>
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
                          onClick={() =>
                            act(() => host('agents.reinstall', { agentId: status.id }))
                          }
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
                </RowGroup>
              </div>
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
  const refresh = useRefresh({ busy: check.running })
  const now = useNow()
  const checkedAt = status.updateCheckedAt
  const updating = status.task?.kind === 'update' && status.task.state === 'running'
  const line: ReactNode = !status.package ? (
    t('agents.ownInstaller')
  ) : refresh.phase === 'turning' ? (
    t('agents.update.checking')
  ) : updating ? (
    t('agents.update.updating')
  ) : (
    <>
      <span
        aria-hidden
        className={cn(
          'mr-1.5 inline-block size-1.5 rounded-full bg-current align-[0.1em]',
          status.update ? 'text-info' : 'text-success',
        )}
      />
      {status.update
        ? t(
            adapterOnlyUpdate(status) ? 'agents.update.adapterReleased' : 'agents.update.released',
            {
              version: status.update.cliVersion ?? status.update.adapterVersion,
            },
          )
        : t('agents.update.upToDate')}
      <span className="text-tertiary">
        {' · '}
        {checkedAt
          ? t('agents.update.checkedAgo', { ago: longAgo(checkedAt, now) })
          : t('agents.update.notChecked')}
      </span>
    </>
  )
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'version', label: t('agents.versionGroup') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={
                version ? (
                  <span className="font-mono" data-selectable="">
                    {version}
                  </span>
                ) : (
                  <span className="font-normal text-tertiary">{t('agents.notReported')}</span>
                )
              }
              description={line}
            />
          }
        >
          {status.package && (
            <Button
              variant="quiet"
              size="sm"
              className="text-secondary"
              aria-busy={refresh.phase === 'turning'}
              disabled={refresh.phase === 'turning' || updating}
              onClick={() => void refresh.run(checkForAgentUpdates).catch(() => {})}
            >
              <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
              {t('agents.update.check')}
            </Button>
          )}
        </RowFrame>
      </RowGroup>
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
  const [doneSeen, setDoneSeen] = useState(false)
  // An install of an agent that is not installed shows in its install notice instead.
  const task = status.task && (status.task.kind === 'update' || installed) ? status.task : null
  const updating = task?.kind === 'update'
  const next = status.update ? (status.update.cliVersion ?? status.update.adapterVersion) : null
  if (task?.state === 'running') {
    return (
      <Notice
        variant="info"
        icon={<Spinner />}
        title={
          updating && next
            ? t('agents.update.progressTitleTo', { name: status.name, version: next })
            : t(updating ? 'agents.update.progressTitle' : 'agents.install.progressTitle', {
                name: status.name,
              })
        }
        action={
          <Button variant="outline" size="sm" onClick={() => cancelTask(status.id)}>
            {t(updating ? 'agents.update.cancel' : 'agents.install.cancel')}
          </Button>
        }
        more={<TaskLog task={task} />}
      >
        {updating ? t('agents.update.progressBody') : (task.progress.at(-1) ?? task.command)}
      </Notice>
    )
  }
  if (task?.state === 'failed') {
    return <FailedTaskNotice status={status} task={task} />
  }
  if (taskError && !status.task) {
    return (
      <Notice
        variant="error"
        icon={<CircleAlertIcon />}
        title={t(
          taskError.kind === 'update' ? 'agents.update.failedTitle' : 'agents.install.failedTitle',
        )}
        action={<DismissButton onClick={() => cancelTask(status.id)} />}
      >
        <span data-selectable="">{taskError.message}</span>
      </Notice>
    )
  }
  if (status.update) {
    const adapter = adapterOnlyUpdate(status)
    const cli = status.update.cliVersion
    return (
      <Notice
        variant="info"
        icon={<CircleArrowUpIcon />}
        title={
          adapter
            ? t('agents.update.noticeTitleAdapterOnly', {
                package: adapter.name,
                version: status.update.adapterVersion,
              })
            : cli && cli !== version
              ? t('agents.update.noticeTitle', { name: status.name, version: cli })
              : t('agents.update.noticeTitleAdapter', { name: status.name })
        }
        action={
          <Button size="sm" onClick={() => startUpdate(status.id)}>
            {t('agents.update.button')}
          </Button>
        }
      >
        {adapter
          ? t('agents.update.noticeBodyAdapterOnly', {
              package: adapter.name,
              current: adapter.version,
              command: status.cli?.command ?? '',
              name: status.name,
            })
          : t('agents.update.noticeBody', {
              current: version ?? status.package?.version ?? '',
              name: status.name,
            })}
      </Notice>
    )
  }
  if (updated && !doneSeen) {
    return (
      <Notice
        variant="success"
        icon={<CircleCheckIcon />}
        title={t('agents.update.doneTitle', { name: status.name })}
        action={<DismissButton onClick={() => setDoneSeen(true)} />}
      >
        {t('agents.update.doneBody', { name: status.name })}
      </Notice>
    )
  }
  return null
}

/** The small x at a notice's end that puts it away. */
function DismissButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <IconAction label={t('agents.task.dismiss')} onClick={onClick}>
      <XIcon />
    </IconAction>
  )
}

/** A failed install or update: why, its log, and retry, copy or dismiss. */
function FailedTaskNotice({ status, task }: { status: AgentStatus; task: AgentTask }) {
  const { t } = useTranslation(['settings', 'common'])
  const updating = task.kind === 'update'
  return (
    <Notice
      variant="error"
      icon={<CircleAlertIcon />}
      title={t(updating ? 'agents.update.failedTitle' : 'agents.install.failedTitle')}
      action={<DismissButton onClick={() => cancelTask(status.id)} />}
      more={
        <>
          <TaskLog task={task} />
          <span className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => retryTask(status.id, task)}>
              <RotateCwIcon data-icon="inline-start" />
              {t('common:actions.retry')}
            </Button>
            <LogCopyButton task={task} />
          </span>
        </>
      }
    >
      {updating
        ? t('agents.update.failedBody')
        : task.error && <span data-selectable="">{task.error}</span>}
    </Notice>
  )
}

/** What an agent that needs a sign-in asks: its command in a terminal, or a way it signs in itself. */
function SignInNotice({
  status,
  busy,
  onTerminal,
  onAuthenticate,
}: {
  status: AgentStatus
  busy: boolean
  onTerminal: (command: string) => void
  onAuthenticate: (methodId: string) => void
}) {
  const { t } = useTranslation(['settings', 'session'])
  const inTerminal = status.authMethods.filter((m) => m.type === 'terminal' && m.command)
  const first = inTerminal[0]
  const others = status.authMethods.filter((m) => m !== first)
  return (
    <Notice
      variant="warning"
      icon={<LogInIcon />}
      title={t('agents.signInTitle', { name: status.name })}
      action={
        first?.command && (
          <Button size="sm" onClick={() => onTerminal(first.command!)}>
            <SquareTerminalIcon data-icon="inline-start" />
            {t('session:signIn.inTerminal')}
          </Button>
        )
      }
      more={
        (first?.command || others.length > 0) && (
          <>
            {first?.command && (
              <div className="flex items-center gap-1.5 rounded-lg bg-code-block py-0.75 pr-0.75 pl-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-code text-primary"
                  data-selectable=""
                  title={first.command}
                >
                  {first.command}
                </code>
                <CopyAction text={first.command} label={t('session:signIn.copyCommand')} />
              </div>
            )}
            {others.length > 0 && (
              <span className="flex flex-wrap gap-1.5">
                {others.map((method) =>
                  method.type === 'terminal' && method.command ? (
                    <Button
                      key={method.id}
                      size="sm"
                      variant="outline"
                      onClick={() => onTerminal(method.command!)}
                    >
                      {method.name}
                    </Button>
                  ) : (
                    <Button
                      key={method.id}
                      size="sm"
                      variant={first ? 'outline' : 'default'}
                      disabled={busy}
                      title={method.description}
                      onClick={() => onAuthenticate(method.id)}
                    >
                      {method.name}
                    </Button>
                  ),
                )}
              </span>
            )}
          </>
        )
      }
    >
      {first?.description}
    </Notice>
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
      <Notice
        variant="info"
        icon={<Spinner />}
        title={t('agents.install.progressTitle', { name: status.name })}
        action={
          (task || status.package) && (
            <Button variant="outline" size="sm" onClick={() => cancelTask(status.id)}>
              {t('agents.install.cancel')}
            </Button>
          )
        }
        more={lines.length > 0 && <Log lines={lines} />}
      >
        {lines.at(-1) ?? task?.command}
      </Notice>
    )
  }
  if (task?.state === 'failed') return <FailedTaskNotice status={status} task={task} />
  if (!canInstall(status)) return null
  return (
    <Notice
      variant="info"
      icon={<DownloadIcon />}
      title={t('agents.install.title', { name: status.name })}
      action={
        <Button size="sm" onClick={() => startInstall(status.id, method?.id)}>
          {t('agents.install.button')}
        </Button>
      }
      more={
        (!status.package || method) && (
          <>
            {!status.package && (
              <span className="flex items-center gap-3 text-small text-secondary">
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
                className="block truncate rounded-lg bg-code-block px-2.5 py-1.5 font-mono text-code text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
                data-selectable=""
                title={method.command}
              >
                {method.label || method.command}
              </code>
            )}
            {!status.package && (
              <span>
                <Button
                  variant="quiet"
                  size="sm"
                  className="-ml-2 text-secondary"
                  onClick={() =>
                    void window.overbench.dialogs
                      .chooseAgentBinary(status.id)
                      .catch((e: unknown) => console.warn(errorMessage(e)))
                  }
                >
                  {t('agents.install.elsewhere')}
                </Button>
              </span>
            )}
          </>
        )
      }
    >
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
    </Notice>
  )
}

function TaskLog({ task }: { task: AgentTask }) {
  const lines = task.progress.length > 0 ? task.progress : [task.command]
  return <Log lines={lines} error={task.state === 'failed'} />
}

/** A task's output, newest line last and in view: in the text color, or the danger one once failed. */
function Log({ lines, error }: { lines: string[]; error?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div
      ref={box}
      role="log"
      data-selectable=""
      className="max-h-21.5 overflow-auto rounded-lg bg-code-block px-2.5 py-1.75 font-mono text-meta leading-4.5 text-tertiary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            'block truncate',
            i === lines.length - 1 && (error ? 'text-danger' : 'text-primary'),
          )}
          title={line}
        >
          {line}
        </span>
      ))}
    </div>
  )
}

function LogCopyButton({ task }: { task: AgentTask }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="quiet"
      size="sm"
      className="text-secondary"
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
  const refresh = useRefresh()
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const observed = Math.max(0, ...status.limits.map((l) => l.observedAt)) || null
  const actions =
    status.limits.length > 0 && limitsReadable(status) ? (
      <>
        {observed && (
          <span className="text-tertiary">
            {t('agents.usageUpdated', { ago: longAgo(observed, now) })}
          </span>
        )}
        <IconAction
          label={t('agents.refreshUsage')}
          disabled={refresh.phase === 'turning'}
          busy={refresh.phase === 'turning'}
          onClick={() => {
            setRefreshError(null)
            void refresh
              .run(() => refreshLimits(status.id))
              .catch((e: unknown) => setRefreshError(errorMessage(e)))
          }}
        >
          <RefreshIcon phase={refresh.phase} />
        </IconAction>
      </>
    ) : null
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'usage', label: t('agents.usage'), actions }} />
      {status.limits.length > 0 ? (
        <RowGroup>
          {status.limits.map((limit) => {
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
                <span className="flex items-center gap-3">
                  <Progress
                    value={limit.usedPercent ?? 0}
                    tone={tone}
                    className="w-42 [&_[data-slot=progress-track]]:h-1.5"
                    aria-label={t('composer:usage.limits.used', { limit: limitLabel(limit) })}
                  />
                  <span
                    className={cn(
                      'w-9 text-right text-command tabular',
                      tone !== 'success' && 'font-medium',
                      USAGE_TONE_TEXT[tone],
                    )}
                  >
                    {percent(limit)}
                  </span>
                </span>
              </RowFrame>
            )
          })}
        </RowGroup>
      ) : reading && status.capabilities.reports ? (
        <p className="px-1 py-0.5 text-small text-tertiary">{t('agents.readingUsage')}</p>
      ) : limitsReadable(status) && !running ? (
        <RowGroup>
          <RowFrame text={<RowText name={t('agents.planLimits')} />}>
            <ControlError error={error} />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => act(() => refreshLimits(status.id))}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.checkLimits')}
            </Button>
          </RowFrame>
        </RowGroup>
      ) : (
        <p className="px-1 py-0.5 text-small text-tertiary">
          {t('agents.usageNotReported', { name: status.name })}
        </p>
      )}
      {(error ?? refreshError) && status.limits.length > 0 && (
        <p className="px-1 pt-1 text-xs text-danger">{error ?? refreshError}</p>
      )}
    </section>
  )
}

/** A name and its value; "Not reported" while the agent has not said. */
function Fact({ name, mono, children }: { name: string; mono?: boolean; children: ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame compact text={<RowText name={name} />}>
      {children ? (
        // A mask's box reaches past the column, so its blur ends where the text above does.
        <span
          className={cn('text-small has-data-[slot=masked]:-me-1.5', mono && 'font-mono text-code')}
          data-selectable=""
        >
          {children}
        </span>
      ) : (
        <span className="text-small text-tertiary">{t('agents.notReported')}</span>
      )}
    </RowFrame>
  )
}

/** A row of the Configuration group: its name and line, then its place and notes under them. */
function ConfigFrame({
  name,
  description,
  control,
  children,
}: {
  name: string
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <RowShell>
      <div className="flex flex-col gap-1.5 py-2.5">
        <div className="flex min-h-7 items-center gap-4">
          <RowText name={name} description={description} />
          {control && <div className="ml-auto flex shrink-0 items-center gap-2">{control}</div>}
        </div>
        {children}
      </div>
    </RowShell>
  )
}

function ConfigRows({ status, override }: { status: AgentStatus; override: string | null }) {
  const { t } = useTranslation('settings')
  const details = useAgentsStore((s) => s.details[status.id])
  const [act, , error] = useAction()
  const command = status.binaryCommand
  return (
    <>
      {details?.config.map((item) =>
        item.id === 'folder' && status.configDir ? (
          <FolderRow key={item.id} item={item} status={status} configDir={status.configDir} />
        ) : (
          <ConfigRow key={item.id} item={item} status={status} />
        ),
      )}
      {status.cli && <CliRow status={status} cli={status.cli} />}
      {command && (
        <ConfigFrame
          name={t('agents.program')}
          description={t('agents.binaryDescription', { command })}
          control={
            <>
              <ControlError error={error} />
              {override && (
                <Button
                  variant="quiet"
                  size="sm"
                  className="text-secondary"
                  onClick={() =>
                    act(() =>
                      useSettingsStore
                        .getState()
                        .update({ agents: { [status.id]: { binaryPath: null } } }),
                    )
                  }
                >
                  {t('agents.reset')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => act(() => window.overbench.dialogs.chooseAgentBinary(status.id))}
              >
                {t('agents.chooseBinary')}
              </Button>
            </>
          }
        >
          {override ? (
            <PathLine path={override} actions={<PathActions path={override} />} />
          ) : (
            <span className="flex min-h-6.5 items-center text-xs text-tertiary">
              {t('agents.programOnPath', { command })}
            </span>
          )}
        </ConfigFrame>
      )}
      {details && details.config.length === 0 && !command && (
        <RowShell>
          <p className="py-3 text-xs text-secondary">{t('agents.noConfig')}</p>
        </RowShell>
      )}
    </>
  )
}

/** The CLI an adapter runs, why when it is not the installed one, and the choice between them. */
function CliRow({ status, cli }: { status: AgentStatus; cli: AgentCli }) {
  const { t } = useTranslation(['settings', 'common'])
  const [apply, error] = useApply()
  const refresh = useRefresh()
  const [retryError, setRetryError] = useState<string | null>(null)
  const version = useAgentVersion(status)
  const installed = cli.installed
  const { command } = cli
  const problem = installed?.problem
  // A program the environment names runs whatever its problem; any other gives way to the copy.
  const problemNote = !problem
    ? null
    : problem.kind === 'too-old'
      ? t('agents.cli.tooOld', { command, version: installed?.version, minimum: problem.minimum })
      : problem.kind === 'failed'
        ? t(installed?.variable ? 'agents.cli.failedNamed' : 'agents.cli.failed', { command })
        : problem.kind === 'unsupported'
          ? t('agents.cli.unsupported', { command })
          : t('agents.cli.noMinimum', { name: status.name })
  const note = !installed
    ? t('agents.cli.notFound', { command })
    : installed.variable
      ? problemNote
        ? t('agents.cli.setByWith', { env: installed.variable, problem: problemNote })
        : t('agents.setBy', { env: installed.variable })
      : (problemNote ??
        (cli.runs === 'bundled'
          ? t('agents.cli.found', { command, version: installed.version })
          : null))
  // The installed one was asked for and has a problem: the variable names it, or the setting does.
  const attention = !!problem && (!!installed?.variable || cli.prefer === 'installed')
  // The copy is to run but this install has none: the next start downloads it.
  const missing = cli.runs === 'bundled' && cli.needsCopy
  // The running adapter keeps its CLI until it stops, so another choice waits for the next start.
  const pending = cli.active !== null && cli.active !== cli.runs
  const versionTag = version && !missing && (
    <span className="shrink-0 font-mono text-xs text-tertiary">{version}</span>
  )
  return (
    <ConfigFrame
      name={t('agents.program')}
      description={t('agents.cli.description', { command })}
      control={
        <>
          <ControlError error={error ?? retryError} />
          {problem?.kind === 'failed' && (
            <Button
              variant="quiet"
              size="sm"
              className="text-secondary"
              aria-busy={refresh.phase === 'turning'}
              disabled={refresh.phase === 'turning'}
              onClick={() => {
                setRetryError(null)
                void refresh
                  .run(() => useAgentsStore.getState().reloadEnvironment())
                  .catch((e: unknown) => setRetryError(errorMessage(e)))
              }}
            >
              <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
              {t('common:actions.retry')}
            </Button>
          )}
          {installed && !installed.variable && (
            <Segmented
              label={t('agents.cli.choose', { name: status.name })}
              value={cli.prefer}
              options={[
                { value: 'installed', label: t('agents.cli.installed') },
                { value: 'bundled', label: t('agents.cli.bundled') },
              ]}
              onChange={(choice: AgentCliSource) =>
                apply({ agents: { [status.id]: { cli: choice } } })
              }
            />
          )}
        </>
      }
    >
      {cli.runs === 'installed' && installed ? (
        <PathLine path={installed.path} actions={<PathActions path={installed.path} />}>
          {versionTag}
        </PathLine>
      ) : (
        <span className="flex min-h-6.5 items-center gap-2">
          <span className="text-command font-medium">
            {t(missing ? 'agents.cli.notDownloaded' : 'agents.cli.bundledLine')}
          </span>
          {versionTag}
        </span>
      )}
      {note && (
        <span
          className={cn('text-xs', attention ? 'text-secondary' : 'text-tertiary')}
          data-selectable=""
        >
          {note}
        </span>
      )}
      {cli.runs === 'bundled' && installed && (
        <PathLine path={installed.path} actions={<PathActions path={installed.path} />} />
      )}
      {problem?.kind === 'failed' && (
        <span className="text-xs text-tertiary" data-selectable="">
          {problem.reason}
        </span>
      )}
      {missing && (
        <span className="text-xs text-tertiary">
          {t('agents.cli.downloadsNext', { size: cli.copyMegabytes })}
        </span>
      )}
      {pending && <span className="text-xs text-tertiary">{t('agents.cli.nextStart')}</span>}
    </ConfigFrame>
  )
}

function ConfigRow({ item, status }: { item: AgentConfigItem; status: AgentStatus }) {
  const { t } = useTranslation('settings')
  return (
    <ConfigFrame
      name={t(`agents.config.${item.id}`)}
      description={
        item.id === 'folder' ? t('agents.configFolder.description', { name: status.name }) : null
      }
    >
      <ConfigPath item={item} />
      <ConfigNote item={item} />
    </ConfigFrame>
  )
}

/**
 * Claude Code's and Codex's folder: the environment's, or one of the agent's own picked in a
 * native dialog, which keeps its sign-in and settings apart from the CLI in a terminal. The choice
 * takes a line of its own, so the path keeps the row's width.
 */
function FolderRow({
  item,
  status,
  configDir,
}: {
  item: AgentConfigItem
  status: AgentStatus
  configDir: NonNullable<AgentStatus['configDir']>
}) {
  const { t } = useTranslation('settings')
  const chosen = useSettingsStore((s) => s.settings.agents[status.id]?.configDir ?? null)
  const [apply, applyError] = useApply()
  const [act, asking, chooseError] = useAction()
  // Picking "A folder of its own" shows what it changes before any folder is chosen, as Proxy does.
  const [open, setOpen] = useState(false)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const explainId = useId()
  // The running agent keeps its folder until it stops, so another one waits for the next start.
  const pending = configDir.active !== null && configDir.active !== configDir.runs
  const choose = () => {
    // A press while the dialog is open does nothing, so the button keeps the focus.
    if (asking) return
    act(() =>
      window.overbench.dialogs.chooseAgentConfigFolder(status.id).then((path) => {
        if (path) setOpen(false)
      }),
    )
  }
  return (
    <ConfigFrame
      name={t('agents.config.folder')}
      description={t('agents.configFolder.description', { name: status.name })}
    >
      <div className="mt-1 mb-0.5 flex items-center gap-2">
        <Segmented
          label={t('agents.configFolder.label', { name: status.name })}
          value={open || chosen ? 'custom' : 'environment'}
          options={[
            { value: 'environment', label: t('agents.configFolder.useEnvironment') },
            { value: 'custom', label: t('agents.configFolder.custom') },
          ]}
          onChange={(mode: ConfigFolderMode) => {
            const next = configFolderChoice(mode, { chosen: chosen !== null, choosing: open })
            setOpen(next.open)
            if (next.clear) apply({ agents: { [status.id]: { configDir: null } } })
            if (next.open) requestAnimationFrame(() => chooseButton.current?.focus())
          }}
        />
        <ControlError error={applyError ?? chooseError} />
      </div>
      {open && !chosen && (
        <p id={explainId} className="text-xs text-secondary">
          {t('agents.configFolder.explain', { name: status.name })}
        </p>
      )}
      <ConfigPath
        item={item}
        extra={
          (open || chosen) && (
            <Button
              ref={chooseButton}
              variant="outline"
              size="xs"
              className="mr-1.5"
              aria-describedby={open && !chosen ? explainId : undefined}
              onClick={choose}
            >
              {t('agents.configFolder.choose')}
            </Button>
          )
        }
      />
      <ConfigNote item={item} />
      {open && !chosen && (
        <span className="text-xs text-muted-foreground">
          {t('agents.configFolder.untilChosen', { name: status.name })}
        </span>
      )}
      {pending && (
        <span className="text-xs text-tertiary">{t('agents.configFolder.nextStart')}</span>
      )}
    </ConfigFrame>
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
      <ComboboxTrigger className="-mx-1.5 flex min-w-0 items-center gap-1.25 rounded-lg pr-1.25 pl-1.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring data-popup-open:bg-hover [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:transition-transform [&>svg]:duration-(--duration-base) data-popup-open:[&>svg]:rotate-180">
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
                  <AgentStateLine status={agent} className="shrink-0 text-tertiary" />
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
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  const source = environment?.source
  const text = environmentText(t, environment, now)
  return (
    <div data-setting-row="environment" className="relative mt-3.5 flex flex-col gap-1 px-1">
      <FlashMark id="environment" />
      <div className="relative flex items-center gap-2 text-command text-tertiary">
        {!environment || source === 'pending' ? (
          <Spinner className="size-3.5" />
        ) : source === 'fallback' ? (
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
        ) : (
          <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
        )}
        <span className="min-w-0 flex-1">{text}</span>
        <Button
          variant="outline"
          size="sm"
          aria-busy={refresh.phase === 'turning'}
          disabled={refresh.phase === 'turning'}
          onClick={() => {
            setError(null)
            void refresh
              .run(() => useAgentsStore.getState().reloadEnvironment())
              .catch((e: unknown) => setError(errorMessage(e)))
          }}
        >
          <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
          {t('agents.environment.reload')}
        </Button>
      </div>
      {environment?.warning && (
        <p className="relative text-xs text-secondary">{environment.warning}</p>
      )}
      {error && <p className="relative text-xs text-danger">{error}</p>}
    </div>
  )
}
