// Settings > Harnesses: the programs agents run on, how each is installed and updated, the program
// that runs and the agents that use it. Accounts and sign-in are Settings > Agents'.

import { useState, type ReactNode } from 'react'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleArrowUpIcon,
  CircleCheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentInstallMethod, AgentStatus, AgentTask } from '@shared/agent-host'
import type { HarnessId } from '@shared/thread'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { CommandLine } from '@renderer/components/command-line'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { listedInstalled, readiness } from '@renderer/features/agents/readiness'
import { adapterOnlyUpdate } from '@renderer/features/agents/updates'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  harnessStatuses,
  isInstalled,
  usableAgents,
  type AgentsStoreHook,
} from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { openAgentSettings, openHarnessSettings } from '@renderer/stores/view'
import { ConfigFrame, DismissButton, Fact, Log, LogCopyButton, TaskLog } from './agent-parts'
import { harnessVersion, useAction, VENDORS } from './agent-helpers'
import { ControlError, CopyAction, GROUP_ACTION } from './controls'
import { PathActions, PathLine } from './places'
import {
  FlashMark,
  GroupLabel,
  ItemPageHeader,
  ItemRow,
  Notice,
  RowFrame,
  RowGroup,
  RowText,
} from './rows'
import { environmentText } from './environment-text'

/** A check the user started counts as just done for this long, then it reads as "checked ago". */
const JUST_CHECKED_MS = 60_000

type SettingsT = ReturnType<typeof useTranslation<'settings'>>['t']

/**
 * Checks every harness for updates. The store records a failure as `updateCheck.error`, so reject
 * as well, which keeps a failed check from showing the icon's check.
 */
async function checkForUpdates(agents: AgentsStoreHook): Promise<void> {
  await agents.getState().checkUpdates()
  const error = agents.getState().updateCheck.error
  if (error) throw new Error(error)
}

/** The harness's program is missing, so it installs by one of its vendor's routes. */
function programMissing(status: AgentStatus): boolean {
  return status.state === 'not-installed' && !status.cli?.installed
}

/** The way Kettu would install it now, or null when it cannot. */
function installMethod(status: AgentStatus, picked?: string): AgentInstallMethod | null {
  const available = status.installMethods.filter((m) => m.available)
  return available.find((m) => m.id === picked) ?? available[0] ?? null
}

/** What Install does: run a route for the program, or install Kettu's package for it. */
function installKind(status: AgentStatus): 'program' | 'package' | null {
  if (programMissing(status) && status.installMethods.length > 0) return 'program'
  if (status.package && !status.package.installed && status.state === 'available') return 'package'
  return null
}

function startInstall(
  agents: AgentsStoreHook,
  harness: HarnessId,
  method?: AgentInstallMethod['id'] | null,
): void {
  void agents.getState().install(harness, method ?? undefined)
}

function startUpdate(agents: AgentsStoreHook, harness: HarnessId): void {
  void agents.getState().update(harness)
}

function startCliUpdate(agents: AgentsStoreHook, harness: HarnessId): void {
  void agents.getState().updateCli(harness)
}

function cancelTask(agents: AgentsStoreHook, harness: HarnessId): void {
  void agents.getState().cancelTask(harness)
}

/** Runs a failed task again, by the route it took; an update with a route is the program's own. */
function retryTask(agents: AgentsStoreHook, harness: HarnessId, task: AgentTask): void {
  if (task.kind === 'update') {
    if (task.method) startCliUpdate(agents, harness)
    else startUpdate(agents, harness)
  } else startInstall(agents, harness, task.method)
}

function methodName(t: SettingsT, method: AgentInstallMethod['id']): string {
  return t(`harnesses.methods.${method}`)
}

/** How Kettu drives it: the SDK, `codex app-server`, or ACP. */
function connectionName(status: AgentStatus): string {
  if (status.package?.isSdk) return 'Claude Agent SDK'
  if (status.harnessId === 'codex') return 'codex app-server'
  return 'ACP'
}

/** Whose program runs: the user's, picked in Settings, or Kettu's package. */
function programText(t: SettingsT, status: AgentStatus): string | null {
  if (status.binaryOverride) return t('harnesses.picked')
  if (status.cli) return t('harnesses.yours', { command: status.cli.command })
  if (status.binaryCommand) return t('harnesses.yours', { command: status.binaryCommand })
  return status.package ? t('harnesses.kettus', { name: status.package.name }) : null
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

/** What a harness's row offers next to its name: install, update, or how either is going. */
function HarnessPill({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const [installing, setInstalling] = useState(false)
  const task: AgentTask | null = status.task
  const harness = status.harnessId
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
            onClick={() => cancelTask(useAgentsStore, harness)}
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
          onClick={() => retryTask(useAgentsStore, harness, task)}
          className="inline-flex items-center gap-1 rounded-sm outline-none focus-ring"
        >
          <RotateCwIcon className="size-3" />
          {t(updating ? 'agents.update.failed' : 'agents.install.failed')}
        </button>
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(useAgentsStore, harness)}
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
          onClick={() => cancelTask(useAgentsStore, harness)}
        />
      </Badge>
    )
  }
  const cliUpdate = status.cli?.update
  if (cliUpdate || status.update) {
    return (
      <Badge
        variant="info"
        render={
          <button
            type="button"
            title={cliUpdate?.command}
            // The user's own CLI changes outside Kettu, so its update runs from the page that
            // shows the command; Kettu's own package updates here.
            onClick={() =>
              cliUpdate ? openHarnessSettings(harness) : startUpdate(useAgentsStore, harness)
            }
          />
        }
      >
        <CircleArrowUpIcon data-icon="inline-start" />
        {cliUpdate
          ? t('harnesses.updateTo', { version: cliUpdate.version })
          : t('agents.update.available')}
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
  const kind = installKind(status)
  // The SDK installs itself on first use beside the user's CLI.
  if (!kind || (kind === 'package' && status.package?.isSdk)) return null
  return (
    <>
      <Badge
        variant="info"
        render={
          <button
            type="button"
            onClick={() =>
              kind === 'program' ? setInstalling(true) : startInstall(useAgentsStore, harness)
            }
          />
        }
      >
        <DownloadIcon data-icon="inline-start" />
        {t('agents.install.button')}
      </Badge>
      {kind === 'program' && (
        <InstallDialog status={status} open={installing} onOpenChange={setInstalling} />
      )}
    </>
  )
}

/**
 * Installing the user's own program, such as Claude Code: the vendor's routes, the recommended
 * first, those whose tool is missing disabled, and the command that runs, which can be copied.
 */
function InstallDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [picked, setPicked] = useState<AgentInstallMethod['id'] | undefined>(undefined)
  const method = installMethod(status, picked)
  const vendor = VENDORS[status.harnessId]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('harnesses.install.title', { name: status.harnessName })}</DialogTitle>
          <DialogDescription>
            {t(vendor ? 'harnesses.install.body' : 'harnesses.install.bodyPlain', {
              name: status.harnessName,
              vendor,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-secondary">
            {t('harnesses.install.method')}
          </span>
          <div role="radiogroup" className="flex flex-col gap-1">
            {status.installMethods.map((m, index) => {
              const chosen = method?.id === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  disabled={!m.available}
                  onClick={() => setPicked(m.id)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-(--duration-fast) focus-ring',
                    chosen ? 'bg-selected' : 'hover:bg-hover',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-3.5 shrink-0 place-items-center rounded-full border',
                      chosen ? 'border-primary' : 'border-strong',
                    )}
                  >
                    {chosen && <span className="size-1.75 rounded-full bg-primary" />}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-ui font-medium">
                      {methodName(t, m.id)}
                      {index === 0 && m.available && (
                        <span className="ml-1.5 text-xs font-normal text-tertiary">
                          {t('harnesses.install.recommended')}
                        </span>
                      )}
                    </span>
                    {!m.available && (
                      <span className="text-xs text-tertiary">{t('agents.install.notFound')}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        {method && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-secondary">
              {t('harnesses.install.runs')}
            </span>
            <div className="flex items-center gap-1.5 rounded-lg bg-code-block py-0.75 pr-0.75 pl-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
              <code
                className="min-w-0 flex-1 truncate font-mono text-code text-primary"
                data-selectable=""
                title={method.command}
              >
                {method.command}
              </code>
              <CopyAction text={method.command} label={t('harnesses.install.copy')} />
            </div>
            <span className="text-xs text-tertiary">{t('harnesses.install.ownTerminal')}</span>
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t('common:actions.cancel')}
          </DialogClose>
          <Button
            disabled={!method}
            onClick={() => {
              startInstall(useAgentsStore, status.harnessId, method?.id)
              onOpenChange(false)
            }}
          >
            {t('agents.install.button')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One harness in the list: its version, how it runs, whose program, and how many agents use it. */
export function HarnessListItem({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const agents = useAgentsStore(
    (s) => usableAgents(s.order, s.byId).filter((a) => a.harnessId === status.harnessId).length,
  )
  const r = readiness(status)
  const version = harnessVersion(status)
  const installed = listedInstalled(status) || isInstalled(status)
  const kind = installKind(status)
  const program = programText(t, status)
  // What it needs first; else how it runs, whose program, and how many agents use it.
  const summary: ReactNode =
    status.task?.state === 'running' ? (
      (status.task.progress.at(-1) ?? status.task.command)
    ) : status.state === 'installing' ? (
      (status.progress.at(-1) ?? t('agents.install.installing'))
    ) : status.task?.state === 'failed' ? (
      <span className="text-danger">{status.task.error}</span>
    ) : taskError ? (
      <span className="text-danger">{taskError.message}</span>
    ) : kind === 'package' ? (
      status.package?.isSdk ? (
        // The user's CLI is there; only the SDK that drives it comes on first use.
        status.cli?.installed ? (
          [connectionName(status), program, t('harnesses.sdkOnFirstUse')]
            .filter(Boolean)
            .join(' · ')
        ) : (
          t('agents.install.missingLineSdk')
        )
      ) : (
        t('agents.install.missingLineAdapter')
      )
    ) : kind === 'program' ? (
      t('harnesses.missingLine', { name: status.harnessName })
    ) : r.kind === 'missing' || r.kind === 'failed' ? (
      r.message
    ) : (
      [
        connectionName(status),
        program,
        agents > 1 ? t('harnesses.agentCount', { count: agents }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    )
  return (
    <ItemRow
      item={status.harnessId}
      label={status.harnessName}
      onOpen={() => openHarnessSettings(status.harnessId)}
      tile={<AgentTile agent={status.harnessId} mono={!installed} size={30} glyph={16} />}
      name={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{status.harnessName}</span>
          {version && (
            <span className="shrink-0 font-mono text-xs font-normal text-tertiary">{version}</span>
          )}
          <span className="pointer-events-auto flex shrink-0">
            <HarnessPill status={status} />
          </span>
        </span>
      }
    >
      {summary && (
        <span className="flex min-h-4.5 min-w-0 items-center text-command leading-4.5 text-secondary">
          <span className="min-w-0 truncate">{summary}</span>
        </span>
      )}
    </ItemRow>
  )
}

/** The Installed group's own action: check every harness for updates, and when it last did. */
export function HarnessGroupActions() {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const harnesses = useAgentsStore(useShallow((s) => harnessStatuses(s.order, s.byId)))
  const refresh = useRefresh({ busy: check.running })
  const now = useNow()
  const checkable = harnesses.some((h) => h.package || h.updateCheckedAt !== null || h.cli)
  const lastAt = Math.max(0, ...harnesses.map((h) => h.updateCheckedAt ?? 0)) || null
  const pending = harnesses.filter((h) => h.update || h.cli?.update).length
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
          onClick={() => void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})}
          className={GROUP_ACTION}
        >
          <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
          {t('agents.update.check')}
        </Button>
      )}
    </>
  )
}

/** A harness's own page: its version and updates, the program that runs, and its agents. */
export function HarnessPage({ harnessId }: { harnessId: HarnessId }) {
  const { useAgentsStore } = useHostScope()
  const status = useAgentsStore((s) => s.byId[harnessId])
  if (!status) return <HarnessPageHeader status={null} />
  return <HarnessPageBody status={status} />
}

function HarnessPageHeader({ status }: { status: AgentStatus | null }) {
  const { t } = useTranslation('settings')
  const installed = !!status && (listedInstalled(status) || isInstalled(status))
  return (
    <ItemPageHeader
      back={t('sections.harnesses')}
      onBack={() => openHarnessSettings(null)}
      item={status?.harnessId ?? 'harness'}
      icon={status && <AgentMark agent={status.harnessId} size={22} mono={!installed} />}
      title={status ? <HarnessPicker status={status} /> : null}
    >
      {status && <HarnessPageLine status={status} />}
    </ItemPageHeader>
  )
}

/** The line under a harness's title: who makes it and how Kettu drives it. */
function HarnessPageLine({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const vendor = VENDORS[status.harnessId]
  const adapter = status.package?.name.split('/').at(-1)
  const connection = vendor
    ? status.package?.isSdk || status.harnessId === 'codex'
      ? t('agents.ownInterface', { vendor })
      : adapter
        ? t('agents.via', { vendor, adapter })
        : t('agents.direct', { vendor })
    : null
  return (
    connection && (
      <p className="flex min-w-0 items-center gap-1.75 text-command leading-4.5 text-tertiary">
        <span className="truncate">{connection}</span>
      </p>
    )
  )
}

function HarnessPageBody({ status }: { status: AgentStatus }) {
  const { request, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const environment = useAgentsStore((s) => s.environment)
  const [act, busy, error] = useAction()
  const r = readiness(status)
  const installed = listedInstalled(status) || isInstalled(status)
  const kind = installKind(status)
  return (
    <div className="flex flex-col">
      <HarnessPageHeader status={status} />

      <div className="flex flex-col gap-7">
        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="-mt-4 px-1 text-xs text-secondary" data-selectable="">
            {status.detail}
          </p>
        )}
        {r.kind === 'missing' && !kind && (
          <p className="-mt-4 px-1 text-xs text-secondary" data-selectable="">
            {r.message}
            {r.url && (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants({ variant: 'link', size: 'xs' }), 'ml-1')}
              >
                {r.action}
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            )}
          </p>
        )}
        {error && <p className="-mt-4 px-1 text-xs text-danger">{error}</p>}

        <TaskNotice status={status} installed={installed} />
        {kind && <InstallNotice status={status} kind={kind} />}

        <VersionGroup status={status} />
        <ProgramGroup status={status} />
        {status.package && <PackageGroup status={status} />}
        <AgentsGroup status={status} />

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
                  {status.package?.installed && (
                    <RowFrame
                      text={
                        <RowText
                          name={t('harnesses.reinstall', { name: status.package.name })}
                          description={t('harnesses.reinstallBody')}
                        />
                      }
                    >
                      <Button
                        variant="outline"
                        size="compact"
                        disabled={busy || r.kind === 'installing' || r.kind === 'starting'}
                        onClick={() =>
                          act(() => request('agents.reinstall', { agentId: status.harnessId }))
                        }
                      >
                        {busy && <Spinner data-icon="inline-start" />}
                        {t('agents.reinstall')}
                      </Button>
                    </RowFrame>
                  )}
                  {status.package && !status.package.isSdk && environment?.nodeVersion && (
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

/** The harness's version, whether a newer one exists, and the check for it. */
function VersionGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const refresh = useRefresh({ busy: check.running })
  const now = useNow()
  const version = harnessVersion(status)
  const checkedAt = status.updateCheckedAt
  const checks = !!status.package || !!status.cli || checkedAt !== null
  const updating = status.task?.kind === 'update' && status.task.state === 'running'
  const next = status.cli?.update?.version ?? status.update?.cliVersion ?? null
  const line: ReactNode = !checks ? (
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
          next || status.update ? 'text-info' : 'text-success',
        )}
      />
      {next
        ? t('agents.update.released', { version: next })
        : status.update
          ? t(
              status.package?.isSdk ? 'agents.update.sdkReleased' : 'agents.update.adapterReleased',
              {
                version: status.update.adapterVersion,
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
          {checks && (
            <Button
              variant="quiet"
              size="sm"
              className="text-secondary"
              aria-busy={refresh.phase === 'turning'}
              disabled={refresh.phase === 'turning' || updating}
              onClick={() =>
                void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})
              }
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
function TaskNotice({ status, installed }: { status: AgentStatus; installed: boolean }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const [doneSeen, setDoneSeen] = useState(false)
  const name = status.harnessName
  const harness = status.harnessId
  // An install of a harness that is not installed shows in its install notice instead.
  const task = status.task && (status.task.kind === 'update' || installed) ? status.task : null
  const updating = task?.kind === 'update'
  const version = harnessVersion(status)
  const cliUpdate = status.cli?.update ?? null
  const next = cliUpdate?.version ?? status.update?.cliVersion ?? status.update?.adapterVersion
  if (task?.state === 'running') {
    return (
      <Notice
        variant="info"
        icon={<Spinner />}
        title={
          updating && next
            ? t('agents.update.progressTitleTo', { name, version: next })
            : t(updating ? 'agents.update.progressTitle' : 'agents.install.progressTitle', {
                name,
              })
        }
        action={
          <Button variant="outline" size="sm" onClick={() => cancelTask(useAgentsStore, harness)}>
            {t(updating ? 'agents.update.cancel' : 'agents.install.cancel')}
          </Button>
        }
        more={<TaskLog task={task} />}
      >
        {updating ? t('agents.update.progressBody') : (task.progress.at(-1) ?? task.command)}
      </Notice>
    )
  }
  if (task?.state === 'failed') return <FailedTaskNotice status={status} task={task} />
  if (taskError && !status.task) {
    return (
      <Notice
        variant="error"
        icon={<CircleAlertIcon />}
        title={t(
          taskError.kind === 'update' ? 'agents.update.failedTitle' : 'agents.install.failedTitle',
        )}
        action={<DismissButton onClick={() => cancelTask(useAgentsStore, harness)} />}
      >
        <span data-selectable="">{taskError.message}</span>
      </Notice>
    )
  }
  if (cliUpdate) {
    const outdated = status.cli?.installed?.problem?.kind === 'too-old'
    return (
      <Notice
        variant={outdated ? 'warning' : 'info'}
        icon={outdated ? <TriangleAlertIcon /> : <CircleArrowUpIcon />}
        title={t('agents.update.noticeTitle', { name, version: cliUpdate.version })}
        action={
          <Button size="sm" onClick={() => startCliUpdate(useAgentsStore, harness)}>
            {t('harnesses.updateTo', { version: cliUpdate.version })}
          </Button>
        }
        more={<CommandLine command={cliUpdate.command} />}
      >
        {outdated
          ? t('harnesses.cliOutdated', { name, current: version ?? '' })
          : t(status.package?.isSdk ? 'harnesses.cliUpdateBodySdk' : 'harnesses.cliUpdateBody', {
              current: version ?? '',
              name,
            })}
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
              ? t('agents.update.noticeTitle', { name, version: cli })
              : t('agents.update.noticeTitleAdapter', { name })
        }
        action={
          <Button size="sm" onClick={() => startUpdate(useAgentsStore, harness)}>
            {t('agents.update.button')}
          </Button>
        }
      >
        {adapter
          ? t(
              status.package?.isSdk
                ? 'agents.update.noticeBodySdkOnly'
                : 'agents.update.noticeBodyAdapterOnly',
              {
                package: adapter.name,
                current: adapter.version,
                command: status.cli?.command ?? '',
                name,
              },
            )
          : t('agents.update.noticeBody', {
              current: version ?? status.package?.version ?? '',
              name,
            })}
      </Notice>
    )
  }
  if (updated && !doneSeen) {
    return (
      <Notice
        variant="success"
        icon={<CircleCheckIcon />}
        title={t('agents.update.doneTitle', { name })}
        action={<DismissButton onClick={() => setDoneSeen(true)} />}
      >
        {t('agents.update.doneBody', { name })}
      </Notice>
    )
  }
  return null
}

/** A failed install or update: why, its log, and retry, copy or dismiss. */
function FailedTaskNotice({ status, task }: { status: AgentStatus; task: AgentTask }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const updating = task.kind === 'update'
  return (
    <Notice
      variant="error"
      icon={<CircleAlertIcon />}
      title={t(updating ? 'agents.update.failedTitle' : 'agents.install.failedTitle')}
      action={<DismissButton onClick={() => cancelTask(useAgentsStore, status.harnessId)} />}
      more={
        <>
          <TaskLog task={task} />
          <span className="flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => retryTask(useAgentsStore, status.harnessId, task)}
            >
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

/** Installing a harness: its program by a route in the dialog, or Kettu's package; then progress. */
function InstallNotice({ status, kind }: { status: AgentStatus; kind: 'program' | 'package' }) {
  const { api, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const task = status.task?.kind === 'install' ? status.task : null
  const name = status.harnessName
  if (task?.state === 'running' || status.state === 'installing') {
    const lines = task ? task.progress : status.progress
    return (
      <Notice
        variant="info"
        icon={<Spinner />}
        title={t('agents.install.progressTitle', { name })}
        action={
          (task || status.package) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cancelTask(useAgentsStore, status.harnessId)}
            >
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
  if (kind === 'package') {
    // The SDK installs itself on first use beside the user's CLI; nothing waits on the user.
    if (status.package?.isSdk) return null
    return (
      <Notice
        variant="info"
        icon={<DownloadIcon />}
        title={t('agents.install.title', { name })}
        action={
          <Button size="sm" onClick={() => startInstall(useAgentsStore, status.harnessId)}>
            {t('agents.install.button')}
          </Button>
        }
      >
        {t('agents.install.adapterBody', { package: status.package?.name ?? '', name })}
      </Notice>
    )
  }
  return (
    <Notice
      variant="info"
      icon={<DownloadIcon />}
      title={t('agents.install.title', { name })}
      action={
        <Button size="sm" onClick={() => setOpen(true)}>
          {t('harnesses.install.open')}
        </Button>
      }
      more={
        status.binaryCommand && (
          <span>
            <Button
              variant="quiet"
              size="sm"
              className="-ml-2 text-secondary"
              onClick={() =>
                void api.dialogs
                  .chooseAgentBinary(status.harnessId)
                  .catch((e: unknown) => console.warn(errorMessage(e)))
              }
            >
              {t('agents.install.elsewhere')}
            </Button>
          </span>
        )
      }
    >
      {status.cli
        ? t('harnesses.install.cliBody', { name, command: status.cli.command })
        : t('agents.install.body')}
      <InstallDialog status={status} open={open} onOpenChange={setOpen} />
    </Notice>
  )
}

/**
 * The program that runs: the user's own CLI or binary, with its version, how it was installed, and
 * another one picked in a dialog for a harness that runs a binary.
 */
function ProgramGroup({ status }: { status: AgentStatus }) {
  const { api, useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const override = useSettingsStore((s) => s.settings.agents[status.harnessId]?.binaryPath)
  const [act, , error] = useAction()
  const installed = status.cli?.installed ?? null
  const command = status.cli?.command ?? status.binaryCommand
  if (!command) return null
  const version = harnessVersion(status)
  const method = status.cli?.method ?? null
  const path = override ?? installed?.path ?? null
  const problem = installed?.problem
  const note = installed?.variable
    ? t('agents.setBy', { env: installed.variable })
    : problem?.kind === 'unsupported'
      ? t('agents.cli.unsupported', { command })
      : problem?.kind === 'failed'
        ? problem.reason
        : !path
          ? t('agents.cli.notFound', { command })
          : null
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'program', label: t('agents.program') }} />
      <RowGroup>
        <ConfigFrame
          name={t('harnesses.programName', { command })}
          description={
            method
              ? t('harnesses.installedWith', { method: methodName(t, method) })
              : status.package?.isSdk
                ? t('harnesses.programSdk')
                : t('harnesses.programOwn')
          }
          control={
            status.binaryCommand && (
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
                          .update({ agents: { [status.harnessId]: { binaryPath: null } } }),
                      )
                    }
                  >
                    {t('agents.reset')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => act(() => api.dialogs.chooseAgentBinary(status.harnessId))}
                >
                  {t('agents.chooseBinary')}
                </Button>
              </>
            )
          }
        >
          {path ? (
            <PathLine path={path} actions={<PathActions path={path} />}>
              {version && (
                <span className="shrink-0 font-mono text-xs text-tertiary">{version}</span>
              )}
            </PathLine>
          ) : (
            <span className="flex min-h-6.5 items-center text-xs text-tertiary">
              {t('agents.programOnPath', { command })}
            </span>
          )}
          {note && (
            <span className="text-xs text-tertiary" data-selectable="">
              {note}
            </span>
          )}
        </ConfigFrame>
      </RowGroup>
    </section>
  )
}

/** Kettu's own package for the harness: Claude Code's SDK or an ACP adapter, and its updates. */
function PackageGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const pkg = status.package
  if (!pkg) return null
  const range = `${pkg.version.split('.').slice(0, 2).join('.')}.x`
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'package', label: t('harnesses.packageGroup') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={
                <span className="font-mono" data-selectable="">
                  {pkg.name}
                </span>
              }
              description={
                pkg.installed
                  ? t(pkg.isSdk ? 'harnesses.sdkLine' : 'harnesses.adapterLine', {
                      version: pkg.version,
                    })
                  : t('agents.installsOnFirstUse')
              }
            />
          }
        >
          {status.update && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => startUpdate(useAgentsStore, status.harnessId)}
            >
              {t('harnesses.updateTo', { version: status.update.adapterVersion })}
            </Button>
          )}
        </RowFrame>
      </RowGroup>
      <p className="px-1 pt-1.5 text-xs text-tertiary">
        {pkg.isSdk
          ? t('harnesses.sdkNote', { name: status.harnessName, range })
          : t('harnesses.adapterNote', { name: status.harnessName })}
      </p>
    </section>
  )
}

/** The agents that use the harness; they are added and changed in Settings > Agents. */
function AgentsGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId)
        .filter((a) => a.harnessId === status.harnessId)
        .map((a) => a.name),
    ),
  )
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'agents', label: t('sections.agents') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={t('harnesses.usedBy')}
              description={agents.join(t('harnesses.listSeparator'))}
            />
          }
        >
          <Button variant="outline" size="sm" onClick={() => openAgentSettings(null)}>
            {t('harnesses.manageAgents')}
          </Button>
        </RowFrame>
      </RowGroup>
    </section>
  )
}

/** The harness's name as the page's title, opening a searchable list of the harnesses. */
function HarnessPicker({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const harnesses = useAgentsStore(useShallow((s) => harnessStatuses(s.order, s.byId)))
  const { contains } = useComboboxFilter()
  const name = (id: HarnessId) => harnesses.find((h) => h.harnessId === id)?.harnessName ?? id
  return (
    <Combobox
      items={harnesses.map((h) => h.harnessId)}
      value={status.harnessId}
      onValueChange={(id: HarnessId | null) => {
        if (id) openHarnessSettings(id)
      }}
      itemToStringLabel={name}
      filter={(id: HarnessId, query: string) => contains(name(id), query)}
    >
      <ComboboxTrigger className="-mx-1.5 flex min-w-0 items-center gap-1.25 rounded-lg pr-1.25 pl-1.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring data-popup-open:bg-hover [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:transition-transform [&>svg]:duration-(--duration-base) data-popup-open:[&>svg]:rotate-180">
        <span className="truncate">{status.harnessName}</span>
      </ComboboxTrigger>
      <ComboboxContent className="w-72">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('harnesses.search')}
          aria-label={t('harnesses.search')}
          spellCheck={false}
        />
        <ComboboxEmpty>{t('harnesses.noMatch')}</ComboboxEmpty>
        <ComboboxList>
          {(id: HarnessId) => {
            const harness = harnesses.find((h) => h.harnessId === id)
            return (
              harness && (
                <ComboboxItem key={id} value={id}>
                  <AgentMark agent={id} size={14} mono={!isInstalled(harness)} />
                  <span className="min-w-0 flex-1 truncate">{harness.harnessName}</span>
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
  const { useAgentsStore } = useHostScope()
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
