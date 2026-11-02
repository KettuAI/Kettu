// Settings > Harnesses: the programs agents run on, how each is installed and updated, the program
// that runs and the agents that use it. Accounts and sign-in are Settings > Agents'.

import { useState, type ReactNode } from 'react'
import {
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
import { AgentTile } from '@renderer/components/agents/agent-mark'
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
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
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
import { ControlError, CopyAction, GROUP_ACTION, Pill, ROW_BUTTON } from './controls'
import { PathActions, PathLine } from './places'
import {
  SETTINGS_TILE,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'
import {
  FlashMark,
  GroupLabel,
  ItemPageHeader,
  ItemLine,
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

/**
 * The end of a harness's row: how an install or update is going, the version that is out with
 * Update, Install, or that it is up to date once a check has run.
 */
function HarnessState({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const [installing, setInstalling] = useState(false)
  const task: AgentTask | null = status.task
  const harness = status.harnessId
  if (task?.state === 'running' || status.state === 'installing') {
    return (
      <span className="flex items-center gap-1.5 text-hint whitespace-nowrap text-secondary">
        <Spinner className="size-3" />
        {t(task?.kind === 'update' ? 'agents.update.updating' : 'agents.install.installing')}
      </span>
    )
  }
  if (task?.state === 'failed') {
    const updating = task.kind === 'update'
    return (
      <Badge
        variant="error"
        className="rounded-tile pr-1 has-[[data-retry]:hover]:bg-destructive-tint-hover"
      >
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
      <Badge variant="error" className="rounded-tile pr-1" title={taskError.message}>
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
  const version = cliUpdate?.version ?? status.update?.cliVersion ?? status.update?.adapterVersion
  if (cliUpdate || status.update) {
    return (
      <>
        {version && <Pill tone="attention">{t('harnesses.versionOut', { version })}</Pill>}
        <Button
          variant="outline"
          className={ROW_BUTTON}
          title={cliUpdate?.command}
          // The user's own CLI changes outside Kettu, so its update runs from the page that shows
          // the command; Kettu's own package updates here.
          onClick={() =>
            cliUpdate ? openHarnessSettings(harness) : startUpdate(useAgentsStore, harness)
          }
        >
          {t('agents.update.button')}
        </Button>
      </>
    )
  }
  if (updated) return <StateDot label={t('agents.update.done')} />
  const kind = installKind(status)
  // The SDK installs itself on first use beside the user's CLI.
  if (kind === 'package' && status.package?.isSdk) return null
  if (kind) {
    return (
      <>
        <Button
          variant="outline"
          className={ROW_BUTTON}
          onClick={() =>
            kind === 'program' ? setInstalling(true) : startInstall(useAgentsStore, harness)
          }
        >
          {t(kind === 'program' ? 'agents.install.buttonDialog' : 'agents.install.button')}
        </Button>
        {kind === 'program' && (
          <InstallDialog status={status} open={installing} onOpenChange={setInstalling} />
        )}
      </>
    )
  }
  return status.updateCheckedAt !== null || status.cli ? (
    <StateDot label={t('agents.update.upToDate')} />
  ) : null
}

/** A state in the success color's dot, such as Up to date. */
function StateDot({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-hint whitespace-nowrap text-secondary">
      <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-success" />
      {label}
    </span>
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
      <SettingsDialogContent className="sm:max-w-125">
        <SettingsDialogHeader title={t('harnesses.install.title', { name: status.harnessName })}>
          {t(vendor ? 'harnesses.install.body' : 'harnesses.install.bodyPlain', {
            name: status.harnessName,
            vendor,
          })}
        </SettingsDialogHeader>
        <SettingsDialogBody>
          <SettingsField label={t('harnesses.install.method')}>
            <RadioGroup
              aria-label={t('harnesses.install.method')}
              value={method?.id ?? null}
              onValueChange={(id) => setPicked(id as AgentInstallMethod['id'])}
              className="gap-5"
            >
              {status.installMethods.map((m, index) => (
                <RadioGroupTile
                  key={m.id}
                  value={m.id}
                  disabled={!m.available}
                  className={SETTINGS_TILE}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="leading-[normal]">
                      {methodName(t, m.id)}
                      {index === 0 && m.available && (
                        <>
                          {' '}
                          <Badge
                            variant="recommended"
                            className="rounded-tile border-0 font-medium"
                          >
                            {t('harnesses.install.recommended')}
                          </Badge>
                        </>
                      )}
                    </span>
                    {!m.available && (
                      <span className="text-hint text-tertiary">
                        {t('agents.install.notFound')}
                      </span>
                    )}
                  </span>
                </RadioGroupTile>
              ))}
            </RadioGroup>
          </SettingsField>
          {method && (
            <SettingsField label={t('harnesses.install.runs')}>
              <div className="flex items-center gap-2 rounded-segments bg-code-block px-3 py-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] [&>button]:size-6.5 [&>button]:rounded-segment [&>button>svg]:size-3.5!">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-hint text-primary"
                  data-selectable=""
                  title={method.command}
                >
                  {method.command}
                </code>
                <CopyAction text={method.command} label={t('harnesses.install.copy')} />
              </div>
              <span className="text-hint text-tertiary">{t('harnesses.install.ownTerminal')}</span>
            </SettingsField>
          )}
          {status.binaryCommand && (
            <ChooseElsewhere harness={status.harnessId} onChosen={() => onOpenChange(false)} />
          )}
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <DialogClose render={<Button variant="ghost" className={ROW_BUTTON} />}>
            {t('common:actions.cancel')}
          </DialogClose>
          <Button
            className={ROW_BUTTON}
            disabled={!method}
            onClick={() => {
              startInstall(useAgentsStore, status.harnessId, method?.id)
              onOpenChange(false)
            }}
          >
            {t('agents.install.button')}
          </Button>
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

/**
 * The install dialog's link to a program installed elsewhere, and why main refused the one chosen.
 * It mounts with the dialog's content, so a refusal is gone when the dialog opens again.
 */
function ChooseElsewhere({ harness, onChosen }: { harness: HarnessId; onChosen: () => void }) {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const [act, , error] = useAction()
  return (
    <>
      <button
        type="button"
        onClick={() =>
          act(() => api.dialogs.chooseAgentBinary(harness).then((path) => path && onChosen()))
        }
        className="self-start rounded-sm text-control text-secondary underline decoration-border-strong underline-offset-3 outline-none hover:text-primary focus-ring"
      >
        {t('agents.install.elsewhere')}
      </button>
      {error && <p className="text-hint text-danger">{error}</p>}
    </>
  )
}

/** One harness in the list: its version and how many agents use it, or what it needs first. */
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
  const summary: ReactNode =
    status.task?.state === 'running' ? (
      (status.task.progress.at(-1) ?? status.task.command)
    ) : status.state === 'installing' ? (
      (status.progress.at(-1) ?? t('agents.install.installing'))
    ) : status.task?.state === 'failed' ? (
      <span className="text-danger">{status.task.error}</span>
    ) : taskError ? (
      <span className="text-danger">{taskError.message}</span>
    ) : kind === 'package' && !(status.package?.isSdk && status.cli?.installed) ? (
      t(
        status.package?.isSdk
          ? 'agents.install.missingLineSdk'
          : 'agents.install.missingLineAdapter',
      )
    ) : kind === 'program' ? (
      t('harnesses.missingLine', { name: status.harnessName })
    ) : r.kind === 'missing' || r.kind === 'failed' ? (
      r.message
    ) : (
      [version, agents > 0 ? t('harnesses.agentCount', { count: agents }) : null]
        .filter(Boolean)
        .join(' · ')
    )
  return (
    <ItemRow
      item={status.harnessId}
      label={status.harnessName}
      onOpen={() => openHarnessSettings(status.harnessId)}
      tile={<AgentTile agent={status.harnessId} mono={!installed} size={30} glyph={16} />}
      name={<span className="truncate">{status.harnessName}</span>}
      right={
        <span className="pointer-events-auto flex items-center gap-2">
          <HarnessState status={status} />
        </span>
      }
    >
      {summary && <ItemLine>{summary}</ItemLine>}
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
      {meta && <span className="mr-1 text-hint text-tertiary">{meta}</span>}
      {checkable && (
        <Button
          variant="ghost"
          aria-busy={refresh.phase === 'turning'}
          disabled={refresh.phase === 'turning'}
          onClick={() => void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})}
          className={GROUP_ACTION}
        >
          {refresh.phase === 'turning' && <Spinner data-icon="inline-start" />}
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
      icon={status && <AgentTile agent={status.harnessId} size={40} glyph={22} mono={!installed} />}
      title={status?.harnessName ?? null}
      subtitle={status && <HarnessPageLine status={status} />}
    />
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
  return connection && <span className="truncate">{connection}</span>
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

      <div className="flex flex-col">
        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="mt-3 text-group text-secondary" data-selectable="">
            {status.detail}
          </p>
        )}
        {r.kind === 'missing' && !kind && (
          <p className="mt-3 text-group text-secondary" data-selectable="">
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
        {error && <p className="mt-3 text-group text-danger">{error}</p>}

        <div className="mt-5 empty:hidden">
          <TaskNotice status={status} installed={installed} />
        </div>
        {kind && (
          <div className="mt-5">
            <InstallNotice status={status} kind={kind} />
          </div>
        )}

        <VersionGroup status={status} />
        <ProgramGroup status={status} />
        {status.package && <PackageGroup status={status} />}
        <AgentsGroup status={status} />

        {installed && (
          <Collapsible className="mt-8">
            <CollapsibleTrigger className="group/advanced flex h-7.5 w-full items-center gap-1 rounded-sm text-left text-hint font-medium text-tertiary outline-none hover:text-primary focus-ring">
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
                        className={ROW_BUTTON}
                        variant="outline"

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
              variant="ghost"

              className={cn(ROW_BUTTON, 'text-secondary')}
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
          <Button
            className={ROW_BUTTON}
            variant="outline"
            onClick={() => cancelTask(useAgentsStore, harness)}
          >
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
          <Button className={ROW_BUTTON} onClick={() => startCliUpdate(useAgentsStore, harness)}>
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
          <Button className={ROW_BUTTON} onClick={() => startUpdate(useAgentsStore, harness)}>
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
              className={ROW_BUTTON}
              variant="outline"

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
  const [act, , error] = useAction()
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
              className={ROW_BUTTON}
              variant="outline"

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
          <Button
            className={ROW_BUTTON}
            onClick={() => startInstall(useAgentsStore, status.harnessId)}
          >
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
        <Button className={ROW_BUTTON} onClick={() => setOpen(true)}>
          {t('harnesses.install.open')}
        </Button>
      }
      more={
        status.binaryCommand && (
          <span className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              className={cn(ROW_BUTTON, '-ml-2 text-secondary')}
              onClick={() => act(() => api.dialogs.chooseAgentBinary(status.harnessId))}
            >
              {t('agents.install.elsewhere')}
            </Button>
            <ControlError error={error} />
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
                    variant="ghost"

                    className={cn(ROW_BUTTON, 'text-secondary')}
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
                  className={ROW_BUTTON}
                  variant="outline"

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
                <span className="shrink-0 font-mono text-code text-tertiary">{version}</span>
              )}
            </PathLine>
          ) : (
            <span className="flex min-h-6.5 items-center text-hint text-tertiary">
              {t('agents.programOnPath', { command })}
            </span>
          )}
          {note && (
            <span className="text-hint text-tertiary" data-selectable="">
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
              className={ROW_BUTTON}

              variant="outline"
              onClick={() => startUpdate(useAgentsStore, status.harnessId)}
            >
              {t('harnesses.updateTo', { version: status.update.adapterVersion })}
            </Button>
          )}
        </RowFrame>
      </RowGroup>
      <p className="pt-2.5 text-hint text-tertiary">
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
          <Button className={ROW_BUTTON} variant="outline" onClick={() => openAgentSettings(null)}>
            {t('harnesses.manageAgents')}
          </Button>
        </RowFrame>
      </RowGroup>
    </section>
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
    <div data-setting-row="environment" className="relative mt-6 flex flex-col gap-1">
      <FlashMark id="environment" />
      <div className="relative flex items-center gap-3 text-hint text-tertiary">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {(!environment || source === 'pending') && <Spinner className="size-3.5" />}
          {source === 'fallback' && (
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
          )}
          <span className="min-w-0 flex-1">{text}</span>
        </span>
        <Button
          variant="ghost"
          className={GROUP_ACTION}
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
        <p className="relative text-hint text-secondary">{environment.warning}</p>
      )}
      {error && <p className="relative text-hint text-danger">{error}</p>}
    </div>
  )
}
