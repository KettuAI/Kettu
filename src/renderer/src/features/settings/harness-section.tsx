// Settings > Harnesses: the programs agents run on, how each is installed and updated, the program
// that runs and the agents that use it. Accounts and sign-in are Settings > Agents'.

import { useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  Download04Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentInstallMethod, AgentStatus, AgentTask } from '@shared/agent-host'
import type { HarnessId } from '@shared/thread'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { toast } from '@renderer/components/ui/toast'
import { listedInstalled, readiness, showsCurrent } from '@renderer/features/agents/readiness'
import { adapterOnlyUpdate } from '@renderer/features/agents/updates'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import {
  awaitsPackage,
  harnessStatuses,
  isInstalled,
  usableAgents,
  type AgentsStoreHook,
} from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { openAgentSettings, openHarnessSettings } from '@renderer/stores/view'
import { ConfigFrame, DismissButton, Fact, Log, LogCopyButton, TaskLog } from './agent-parts'
import { installKind, startInstall, type InstallKind, type SettingsHook } from './harness-install'
import { harnessVersion, useAction, VENDORS } from './agent-helpers'
import {
  CommandLine,
  ControlError,
  CopyAction,
  DangerButton,
  LinkButton,
  Pill,
  SetButton,
  Spin,
} from './controls'
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

/** The way Kettu would install it now, or null when it cannot. */
function installMethod(status: AgentStatus, picked?: string): AgentInstallMethod | null {
  const available = status.installMethods.filter((m) => m.available)
  return available.find((m) => m.id === picked) ?? available[0] ?? null
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
function retryTask(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harness: HarnessId,
  task: AgentTask,
): void {
  if (task.kind === 'update') {
    if (task.method) startCliUpdate(agents, harness)
    else startUpdate(agents, harness)
  } else void startInstall(agents, settings, harness, task.method)
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
      className="k-pill-close"
      data-tone={tone}
    >
      <Icon icon={Cancel01Icon} size={10} />
    </button>
  )
}

/**
 * The end of a harness's row: how an install or update is going, the version that is out with
 * Update, Install, or that it is up to date once a check has run.
 */
function HarnessState({ status }: { status: AgentStatus }) {
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const [installing, setInstalling] = useState(false)
  const task: AgentTask | null = status.task
  const harness = status.harnessId
  if (task?.state === 'running' || status.state === 'installing') {
    return (
      <span className="k-end k-muted">
        <Spin />
        {t(task?.kind === 'update' ? 'agents.update.updating' : 'agents.install.installing')}
      </span>
    )
  }
  if (task?.state === 'failed') {
    const updating = task.kind === 'update'
    return (
      <span className="ui-ss-badge k-badge-error">
        <button
          type="button"
          title={task.error ?? undefined}
          onClick={() => retryTask(useAgentsStore, useSettingsStore, harness, task)}
          className="k-badge-action"
        >
          <Icon icon={RefreshIcon} size={12} />
          {t(updating ? 'agents.update.failed' : 'agents.install.failed')}
        </button>
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(useAgentsStore, harness)}
        />
      </span>
    )
  }
  if (taskError) {
    return (
      <span className="ui-ss-badge k-badge-error" title={taskError.message}>
        <span className="k-badge-action">
          <Icon icon={AlertCircleIcon} size={12} />
          {t(
            taskError.kind === 'update'
              ? 'agents.update.failedTitle'
              : 'agents.install.failedTitle',
          )}
        </span>
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(useAgentsStore, harness)}
        />
      </span>
    )
  }
  if (status.uninstalled) {
    return (
      <SetButton onClick={() => void startInstall(useAgentsStore, useSettingsStore, harness)}>
        {t('agents.install.button')}
      </SetButton>
    )
  }
  const cliUpdate = status.cli?.update
  const version = cliUpdate?.version ?? status.update?.cliVersion ?? status.update?.adapterVersion
  if (cliUpdate || status.update) {
    return (
      <>
        {version && <Pill tone="attention">{t('harnesses.versionOut', { version })}</Pill>}
        <SetButton
          variant="primary"
          title={cliUpdate?.command}
          // The user's own CLI changes outside Kettu, so its update runs from the page that shows
          // the command; Kettu's own package updates here.
          onClick={() =>
            cliUpdate ? openHarnessSettings(harness) : startUpdate(useAgentsStore, harness)
          }
        >
          {t('agents.update.button')}
        </SetButton>
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
        <SetButton
          onClick={() =>
            kind === 'package'
              ? void startInstall(useAgentsStore, useSettingsStore, harness)
              : setInstalling(true)
          }
        >
          {t('agents.install.button')}
        </SetButton>
        {kind !== 'package' && (
          <InstallDialog status={status} open={installing} onOpenChange={setInstalling} />
        )}
      </>
    )
  }
  return showsCurrent(status) ? <StateDot label={t('agents.update.upToDate')} /> : null
}

/** A state in the success color's dot, such as Up to date. */
function StateDot({ label }: { label: string }) {
  return (
    <span className="ui-ss-badge" data-tone="ok">
      {label}
    </span>
  )
}

/**
 * Installing the user's own program, such as Claude Code: the vendor's routes, the recommended
 * first, those whose tool is missing disabled, and the command that runs, which can be copied.
 */
export function InstallDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [picked, setPicked] = useState<AgentInstallMethod['id'] | undefined>(undefined)
  const method = installMethod(status, picked)
  const vendor = VENDORS[status.harnessId]
  const [check, checking, error] = useAction()
  const hasMethods = status.installMethods.length > 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="sm:max-w-125">
        <SettingsDialogHeader title={t('harnesses.install.title', { name: status.harnessName })}>
          {t(
            hasMethods
              ? vendor
                ? 'harnesses.install.body'
                : 'harnesses.install.bodyPlain'
              : 'harnesses.install.setupBody',
            { name: status.harnessName, vendor },
          )}
        </SettingsDialogHeader>
        <SettingsDialogBody>
          {hasMethods && (
            <SettingsField label={t('harnesses.install.method')}>
              <RadioGroup
                aria-label={t('harnesses.install.method')}
                value={method?.id ?? null}
                onValueChange={(id) => setPicked(id as AgentInstallMethod['id'])}
                className="kettu-sd__choices"
              >
                {status.installMethods.map((m, index) => (
                  <RadioGroupTile
                    key={m.id}
                    value={m.id}
                    disabled={!m.available}
                    className={SETTINGS_TILE}
                  >
                    <span className="ui-sg-label">
                      <b className="k-row-title">
                        {methodName(t, m.id)}
                        {index === 0 && m.available && (
                          <span className="ui-ss-badge" data-tone="ok">
                            {t('harnesses.install.recommended')}
                          </span>
                        )}
                      </b>
                      {!m.available && <small>{t('agents.install.notFound')}</small>}
                    </span>
                  </RadioGroupTile>
                ))}
              </RadioGroup>
            </SettingsField>
          )}
          {!method && status.detail && (
            <p className="kettu-sd__text" data-selectable="">
              {status.detail}
            </p>
          )}
          {method && (
            <SettingsField
              label={t(
                method.id === 'archive' ? 'harnesses.install.downloads' : 'harnesses.install.runs',
              )}
            >
              <div className="k-cmd k-cmd--wrap">
                <code data-selectable="" title={method.command}>
                  {method.command}
                </code>
                <CopyAction
                  text={method.command}
                  label={t(
                    method.id === 'archive' ? 'common:actions.copy' : 'harnesses.install.copy',
                  )}
                />
              </div>
              <span className="kettu-sd__hint">
                {t(
                  method.id === 'archive'
                    ? 'harnesses.install.downloadBody'
                    : 'harnesses.install.ownTerminal',
                )}
              </span>
            </SettingsField>
          )}
          {method && status.installNotice && (
            <p className="kettu-sd__text" data-selectable="">
              {status.installNotice}
            </p>
          )}
          {status.installUrl && (
            <span>
              <LinkButton
                href={status.installUrl}
                icon={<Icon icon={ArrowUpRight01Icon} size={14} />}
              >
                {t('harnesses.install.guide')}
              </LinkButton>
            </span>
          )}
          {status.binaryCommand && (
            <ChooseElsewhere harness={status.harnessId} onChosen={() => onOpenChange(false)} />
          )}
          <ControlError error={error} />
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <DialogClose render={<SetButton size="md" variant="ghost" />}>
            {t('common:actions.cancel')}
          </DialogClose>
          {method ? (
            <SetButton
              size="md"
              variant="primary"
              onClick={() => {
                void startInstall(useAgentsStore, useSettingsStore, status.harnessId, method.id)
                onOpenChange(false)
              }}
            >
              {t('agents.install.button')}
            </SetButton>
          ) : (
            <SetButton
              size="md"
              variant="primary"
              loading={checking}
              onClick={() => check(() => useAgentsStore.getState().reloadEnvironment())}
            >
              {t('agents.environment.reload')}
            </SetButton>
          )}
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
        className="k-link k-self-start"
      >
        {t('agents.install.elsewhere')}
      </button>
      {error && <p className="kettu-sd__error">{error}</p>}
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
      <span className="k-danger">{status.task.error}</span>
    ) : taskError ? (
      <span className="k-danger">{taskError.message}</span>
    ) : status.uninstalled ? (
      t('harnesses.removedLine')
    ) : awaitsPackage(status) && status.package?.isSdk ? (
      t('agents.installsOnFirstUse')
    ) : kind || awaitsPackage(status) ? (
      t('harnesses.groups.notInstalled')
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
      tile={<AgentTile agent={status.harnessId} mono={!installed} size={32} />}
      name={<span className="k-name">{status.harnessName}</span>}
      right={<HarnessState status={status} />}
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
      <span className="k-error" title={check.error}>
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
        t('agents.update.checkedAgoUpdates', { ago: mediumAgo(lastAt, now), count: pending })
      ) : (
        t('agents.update.checkedAgo', { ago: mediumAgo(lastAt, now) })
      )
    ) : null
  return (
    <>
      {meta && <span className="k-muted k-head-meta">{meta}</span>}
      {checkable && (
        <SetButton
          loading={refresh.phase === 'turning'}
          onClick={() => void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})}
        >
          {t('agents.update.check')}
        </SetButton>
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
      icon={status && <AgentTile agent={status.harnessId} size={42} mono={!installed} />}
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
    ? status.package?.isSdk || status.harnessId === 'codex' || status.harnessId === 'deepseek'
      ? t('agents.ownInterface', { vendor })
      : adapter
        ? t('agents.via', { vendor, adapter })
        : t('agents.direct', { vendor })
    : null
  return connection && <span className="k-name">{connection}</span>
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
    <div>
      <HarnessPageHeader status={status} />

      <div>
        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="ui-sg-hint" data-selectable="">
            {status.detail}
          </p>
        )}
        {r.kind === 'missing' && !kind && (
          <p className="ui-sg-hint" data-selectable="">
            {r.message}{' '}
            {r.url && (
              <a href={r.url} target="_blank" rel="noreferrer" className="k-link">
                {r.action}
              </a>
            )}
          </p>
        )}
        {error && (
          <p className="ui-sg-hint k-error" data-wrap="">
            {error}
          </p>
        )}

        <TaskNotice status={status} installed={installed} />
        {status.uninstalled && <UninstalledNotice status={status} />}
        {kind && <InstallNotice status={status} kind={kind} />}

        <VersionGroup status={status} />
        <ProgramGroup status={status} />
        {status.package && <PackageGroup status={status} />}
        <AgentsGroup status={status} />

        {installed && (
          <Collapsible className="k-group">
            <CollapsibleTrigger className="ui-sg-head k-disclosure">
              <Icon icon={ArrowDown01Icon} size={14} />
              {t('agents.advanced')}
            </CollapsibleTrigger>
            <CollapsibleContent className={PANEL}>
              <div className="k-disclosure__body">
                <RowGroup>
                  <RowFrame
                    text={
                      <RowText
                        name={t('agents.launch')}
                        description={
                          <code className="k-mono k-break" data-selectable="">
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
                      <SetButton
                        loading={busy}
                        disabled={r.kind === 'installing' || r.kind === 'starting'}
                        onClick={() =>
                          act(() => request('agents.reinstall', { agentId: status.harnessId }))
                        }
                      >
                        {t('agents.reinstall')}
                      </SetButton>
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
        {installed && !status.uninstalled && <UninstallGroup status={status} />}
      </div>
    </div>
  )
}

/**
 * Uninstalls what Kettu installed for the harness, and its agents, while the user's own program
 * and configuration stay; offers to remove the program too when its install route can.
 */
function UninstallGroup({ status }: { status: AgentStatus }) {
  const { api, request, useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [removeProgram, setRemoveProgram] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const uninstall = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await request('agents.uninstall', {
        agentId: status.harnessId,
        removeProgram,
      })
      const agents = useAgentsStore.getState()
      const ids = agents.order.filter(
        (id) =>
          agents.byId[id]?.harnessId === status.harnessId && agents.byId[id]?.registered !== false,
      )
      for (const id of ids) await api.settings.removeAgent(id, false)
      await useSettingsStore.getState().update({
        agents: { [status.harnessId]: { uninstalled: true, enabled: false } },
      })
      setOpen(false)
      openHarnessSettings(null)
      if (result.error) toast(result.error, undefined, { tone: 'warning' })
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <section className="k-group">
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={t('harnesses.uninstall.name', { name: status.harnessName })}
              description={t('harnesses.uninstall.description')}
            />
          }
        >
          <DangerButton
            onClick={() => {
              setError(null)
              setRemoveProgram(false)
              setOpen(true)
            }}
          >
            {t('harnesses.uninstall.button')}
          </DangerButton>
        </RowFrame>
      </RowGroup>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="sm:max-w-120">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('harnesses.uninstall.title', { name: status.harnessName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('harnesses.uninstall.body', { name: status.harnessName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {status.uninstallCommand && (
            <label className="flex items-start gap-2.5 rounded-code bg-subtle px-3 py-2.5 text-left">
              <Checkbox
                checked={removeProgram}
                onCheckedChange={(value) => setRemoveProgram(value === true)}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="text-ui font-medium text-primary">
                  {t('harnesses.uninstall.program')}
                </span>
                <code className="font-mono text-xs break-all text-secondary" data-selectable="">
                  {status.uninstallCommand}
                </code>
              </span>
            </label>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void uninstall()}
            >
              {t('harnesses.uninstall.button')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
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
  // A stale check does not make a missing program current, so it gets no green dot.
  const current = !next && !status.update && showsCurrent(status)
  const stated = !!next || !!status.update || current
  const line: ReactNode = !checks ? (
    t('agents.ownInstaller')
  ) : refresh.phase === 'turning' ? (
    t('agents.update.checking')
  ) : updating ? (
    t('agents.update.updating')
  ) : (
    <>
      {stated && (
        <span aria-hidden className="k-dot" data-tone={next || status.update ? 'new' : 'ok'} />
      )}
      {next
        ? t('agents.update.released', { version: next })
        : status.update
          ? t(
              status.package?.isSdk ? 'agents.update.sdkReleased' : 'agents.update.adapterReleased',
              {
                version: status.update.adapterVersion,
              },
            )
          : current
            ? t('agents.update.upToDate')
            : null}
      <span>
        {stated && ' · '}
        {checkedAt
          ? t('agents.update.checkedAgo', { ago: mediumAgo(checkedAt, now) })
          : t('agents.update.notChecked')}
      </span>
    </>
  )
  return (
    <section className="k-group" aria-label={t('agents.versionGroup')}>
      <GroupLabel group={{ id: 'version', label: t('agents.versionGroup') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={
                version ? (
                  <span className="k-mono" data-selectable="">
                    {version}
                  </span>
                ) : (
                  <span className="k-muted">{t('agents.notReported')}</span>
                )
              }
              description={line}
            />
          }
        >
          {checks && (
            <SetButton
              loading={refresh.phase === 'turning'}
              disabled={updating}
              onClick={() =>
                void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})
              }
            >
              {t('agents.update.check')}
            </SetButton>
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
        icon={<Spin />}
        title={
          updating && next
            ? t('agents.update.progressTitleTo', { name, version: next })
            : t(updating ? 'agents.update.progressTitle' : 'agents.install.progressTitle', {
                name,
              })
        }
        action={
          <SetButton onClick={() => cancelTask(useAgentsStore, harness)}>
            {t(updating ? 'agents.update.cancel' : 'agents.install.cancel')}
          </SetButton>
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
        icon={outdated ? undefined : <Icon icon={Download04Icon} size={16} />}
        title={t('agents.update.noticeTitle', { name, version: cliUpdate.version })}
        action={
          <SetButton variant="primary" onClick={() => startCliUpdate(useAgentsStore, harness)}>
            {t('harnesses.updateTo', { version: cliUpdate.version })}
          </SetButton>
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
        icon={<Icon icon={Download04Icon} size={16} />}
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
          <SetButton variant="primary" onClick={() => startUpdate(useAgentsStore, harness)}>
            {t('agents.update.button')}
          </SetButton>
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
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const updating = task.kind === 'update'
  return (
    <Notice
      variant="error"
      title={t(updating ? 'agents.update.failedTitle' : 'agents.install.failedTitle')}
      action={<DismissButton onClick={() => cancelTask(useAgentsStore, status.harnessId)} />}
      more={
        <>
          <TaskLog task={task} />
          <span className="k-end k-wrap">
            <SetButton
              icon={<Icon icon={RefreshIcon} size={14} />}
              onClick={() => retryTask(useAgentsStore, useSettingsStore, status.harnessId, task)}
            >
              {t('common:actions.retry')}
            </SetButton>
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

/** A harness that was uninstalled: Install brings it back with its configuration. */
function UninstalledNotice({ status }: { status: AgentStatus }) {
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  return (
    <Notice
      variant="info"
      icon={<Icon icon={Download04Icon} size={16} />}
      title={t('harnesses.removedLine')}
      action={
        <SetButton
          variant="primary"
          onClick={() => void startInstall(useAgentsStore, useSettingsStore, status.harnessId)}
        >
          {t('agents.install.button')}
        </SetButton>
      }
    >
      {t('harnesses.uninstall.installAgain')}
    </Notice>
  )
}

/** Installing a harness: its program by a route in the dialog, or Kettu's package; then progress. */
function InstallNotice({ status, kind }: { status: AgentStatus; kind: InstallKind }) {
  const { api, useAgentsStore, useSettingsStore } = useHostScope()
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
        icon={<Spin />}
        title={t('agents.install.progressTitle', { name })}
        action={
          (task || status.package) && (
            <SetButton onClick={() => cancelTask(useAgentsStore, status.harnessId)}>
              {t('agents.install.cancel')}
            </SetButton>
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
        icon={<Icon icon={Download04Icon} size={16} />}
        title={t('agents.install.title', { name })}
        action={
          <SetButton
            variant="primary"
            onClick={() => void startInstall(useAgentsStore, useSettingsStore, status.harnessId)}
          >
            {t('agents.install.button')}
          </SetButton>
        }
      >
        {t('agents.install.adapterBody', { package: status.package?.name ?? '', name })}
      </Notice>
    )
  }
  return (
    <Notice
      variant="info"
      icon={<Icon icon={Download04Icon} size={16} />}
      title={t('agents.install.title', { name })}
      action={
        <SetButton variant="primary" onClick={() => setOpen(true)}>
          {t('harnesses.install.open')}
        </SetButton>
      }
      more={
        status.binaryCommand && (
          <span className="k-end">
            <button
              type="button"
              className="k-link"
              onClick={() => act(() => api.dialogs.chooseAgentBinary(status.harnessId))}
            >
              {t('agents.install.elsewhere')}
            </button>
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
    <section className="k-group" aria-label={t('agents.program')}>
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
                  <SetButton
                    variant="ghost"
                    onClick={() =>
                      act(() =>
                        useSettingsStore
                          .getState()
                          .update({ agents: { [status.harnessId]: { binaryPath: null } } }),
                      )
                    }
                  >
                    {t('agents.reset')}
                  </SetButton>
                )}
                <SetButton
                  onClick={() => act(() => api.dialogs.chooseAgentBinary(status.harnessId))}
                >
                  {t('agents.chooseBinary')}
                </SetButton>
              </>
            )
          }
        >
          {path ? (
            <PathLine path={path} actions={<PathActions path={path} />}>
              {version && <span className="k-mono k-muted">{version}</span>}
            </PathLine>
          ) : (
            <span className="k-muted">{t('agents.programOnPath', { command })}</span>
          )}
          {note && (
            <span className="k-muted" data-selectable="">
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
    <section className="k-group" aria-label={t('harnesses.packageGroup')}>
      <GroupLabel group={{ id: 'package', label: t('harnesses.packageGroup') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={
                <span className="k-mono" data-selectable="">
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
            <SetButton
              variant="primary"
              onClick={() => startUpdate(useAgentsStore, status.harnessId)}
            >
              {t('harnesses.updateTo', { version: status.update.adapterVersion })}
            </SetButton>
          )}
        </RowFrame>
      </RowGroup>
      <p className="ui-sg-hint">
        {pkg.isSdk
          ? t('harnesses.sdkNote', { name: status.harnessName, range })
          : status.harnessId === 'deepseek'
            ? t('harnesses.programNote', { name: status.harnessName })
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
    <section className="k-group" aria-label={t('sections.agents')}>
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
          <SetButton onClick={() => openAgentSettings(null)}>
            {t('harnesses.manageAgents')}
          </SetButton>
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
    <div data-setting-row="environment" className="k-row k-env">
      <FlashMark id="environment" />
      <p className="ui-sg-hint k-env__line">
        {(!environment || source === 'pending') && <Spin />}
        {source === 'fallback' && (
          <span className="k-warn">
            <Icon icon={Alert02Icon} size={14} />
          </span>
        )}
        <span>
          {text}{' '}
          <button
            type="button"
            className="k-link"
            disabled={refresh.phase === 'turning'}
            onClick={() => {
              setError(null)
              void refresh
                .run(() => useAgentsStore.getState().reloadEnvironment())
                .catch((e: unknown) => setError(errorMessage(e)))
            }}
          >
            {t('agents.environment.reload')}
          </button>
        </span>
      </p>
      {environment?.warning && <p className="ui-sg-hint">{environment.warning}</p>}
      {error && (
        <p className="ui-sg-hint k-error" data-wrap="">
          {error}
        </p>
      )}
    </div>
  )
}
