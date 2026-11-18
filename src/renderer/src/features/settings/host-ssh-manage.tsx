// What the page of a host added over SSH does to it there, over SSH: update Kettu to this
// computer's version, change the SSH address, reconnect now, and uninstall it while removing it.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import { compareVersions } from '@shared/market-publish'
import type {
  HostStatus,
  SshAddFailure,
  SshAddress,
  SshConfigHost,
  SshConfigHosts,
  SshManageFailure,
  SshManageResult,
} from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
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
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { errorMessage, hostAt, terminalsAt } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { dismissSshUpdate, updateSshHost, useHostsStore } from '@renderer/stores/hosts'
import { Log } from './agent-parts'
import { CONFIRM, DangerButton, FindField, SetButton } from './controls'
import { MachineList, SshAddressFields } from './host-add-ssh'
import { Notice, RowFrame, RowText } from './rows'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'
import {
  draftAddress,
  draftOf,
  machineLine,
  matchMachines,
  sshCommand,
  type SshDraft,
} from './ssh-adding'

type Failed = Extract<SshManageResult, { ok: false }>

/** What the action was, for the sentence of a failure that names none of its own. */
type Action = 'update' | 'address' | 'reconnect' | 'uninstall'

/** A list longer than this gets a filter. */
const FILTER_FROM = 8

/** Failures whose last lines of output say more than the sentence can. */
const WITH_OUTPUT: ReadonlySet<SshManageFailure> = new Set([
  'ssh_unreachable',
  'ssh_install',
  'ssh_failed',
  'uninstall_failed',
])

const thrown = (error: unknown): Failed => ({
  ok: false,
  reason: 'ssh_failed',
  detail: errorMessage(error),
})

type SshErrorKey = SshAddFailure extends `ssh_${infer K}` ? K : never

/** Why an action did not happen, in a sentence, with what to try where there is something. */
function failureText(
  t: TFunction<'settings'>,
  action: Action,
  failed: Failed,
  host: Pick<HostStatus, 'name'>,
  address: SshAddress,
): ReactNode {
  const { reason, detail } = failed
  const values = { name: host.name, target: address.target, command: sshCommand(address) }
  switch (reason) {
    case 'ssh_failed':
      return t(`hosts.page.ssh.failed.${action}`, values)
    case 'ssh_unsupported':
      return detail
        ? t('hosts.add.ssh.errors.unsupported', { ...values, system: detail })
        : t('hosts.add.ssh.errors.noShell', values)
    case 'other_host':
      return t(
        action === 'address' ? 'hosts.page.ssh.otherAddress' : 'hosts.page.ssh.otherHost',
        values,
      )
    case 'unknown_host':
      return t('hosts.failed.unknown_host', values)
    case 'busy':
      return t('hosts.page.ssh.busy', values)
    case 'uninstall_foreign':
      return t('hosts.page.uninstall.foreign', { ...values, path: detail ?? '~/.local/bin/kettu' })
    case 'uninstall_running':
      return t('hosts.page.uninstall.running', values)
    case 'uninstall_failed':
      return t('hosts.page.uninstall.failed', values)
    default:
      return (
        <Trans
          t={t}
          i18nKey={`hosts.add.ssh.errors.${reason.slice(4) as SshErrorKey}`}
          values={values}
          components={{ code: <code className="k-code" /> }}
        />
      )
  }
}

const outputOf = (failed: Failed): string[] | null =>
  failed.detail && WITH_OUTPUT.has(failed.reason) ? failed.detail.split('\n') : null

/** What restarting or uninstalling Kettu there would stop. */
interface HostWork {
  turns: string[]
  terminals: string[]
}

/**
 * Asks the host which of its sessions run a turn, and which terminals run a command in front of
 * their shell; a host that refuses this computer the terminal lists none.
 */
async function readHostWork(t: TFunction<['settings', 'common']>, id: string): Promise<HostWork> {
  const [sessions, terminals] = await Promise.all([
    hostAt(id, 'sessions.list', {}).catch(() => []),
    terminalsAt(id, 'terminals.list', {}).catch(() => []),
  ])
  return {
    turns: sessions
      .filter(
        (session) =>
          session.origin !== 'subagent' &&
          session.archivedAt === null &&
          (session.status === 'running' || session.status === 'awaiting_permission'),
      )
      .map((session) => session.title ?? t('common:untitledSession')),
    terminals: terminals
      .filter((terminal) => terminal.busy && terminal.exitCode === null)
      .map((terminal) =>
        t('hosts.page.ssh.terminal', {
          command: terminal.title,
          project: terminal.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '/',
        }),
      ),
  }
}

/** What runs there, read while `asking` holds and the host is online; null while it is read. */
function useHostWork(host: HostStatus, asking: boolean): HostWork | null {
  const { t } = useTranslation(['settings', 'common'])
  const online = host.connection.state === 'online'
  const [work, setWork] = useState<{ id: string; work: HostWork } | null>(null)
  useEffect(() => {
    if (!asking || !online) return
    let live = true
    void readHostWork(t, host.id).then((read) => {
      if (live) setWork({ id: host.id, work: read })
    })
    return () => {
      live = false
    }
  }, [asking, online, host.id, t])
  if (!online) return { turns: [], terminals: [] }
  return asking && work?.id === host.id ? work.work : null
}

function WorkList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1 rounded-code bg-subtle px-3 py-2.5 text-ui text-primary">
      {items.map((item, i) => (
        <li key={i} className="truncate" title={item}>
          {item}
        </li>
      ))}
    </ul>
  )
}

/**
 * The Connection group's Kettu row: its version there, and Update to this computer's when it is
 * older, which names what the restart stops before it goes on; the update's step and how it
 * failed show here.
 */
export function KettuRow({
  host,
  version,
}: {
  host: HostStatus & { ssh: SshAddress }
  version: string
}) {
  const { t } = useTranslation(['settings', 'common'])
  const update = useHostsStore((s) => s.sshUpdates[host.id] ?? null)
  const [asking, setAsking] = useState(false)
  const [confirming, setConfirming] = useState<HostWork | null>(null)
  const older = compareVersions(host.version, version) < 0
  const updating = update?.state === 'updating'
  const start = async (): Promise<void> => {
    dismissSshUpdate(host.id)
    if (host.connection.state === 'online') {
      setAsking(true)
      const work = await readHostWork(t, host.id)
      setAsking(false)
      if (work.turns.length > 0 || work.terminals.length > 0) return setConfirming(work)
    }
    void updateSshHost(host.id, version)
  }
  const description = updating
    ? t('hosts.page.kettu.updating', { version: update.version })
    : older
      ? t('hosts.page.kettu.older', { version: host.version })
      : host.version
  return (
    <>
      <RowFrame
        text={
          <RowText
            name={t('hosts.page.kettu.name')}
            description={<span aria-live="polite">{description}</span>}
          />
        }
      >
        {(older || updating) && (
          <SetButton
            loading={asking || updating}
            disabled={asking || updating}
            onClick={() => void start()}
          >
            {t('hosts.page.kettu.update', { version: updating ? update.version : version })}
          </SetButton>
        )}
      </RowFrame>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('hosts.page.kettu.confirmTitle', { name: host.name, version })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('hosts.page.kettu.confirmBody', { name: host.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirming && <WorkList items={[...confirming.turns, ...confirming.terminals]} />}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(null)
                void updateSshHost(host.id, version)
              }}
            >
              {t('hosts.page.kettu.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** How the last update of the host failed, under the Connection group's rows. */
export function KettuUpdateFailure({ host }: { host: HostStatus & { ssh: SshAddress } }) {
  const { t } = useTranslation(['settings', 'common'])
  const update = useHostsStore((s) => s.sshUpdates[host.id] ?? null)
  if (update?.state !== 'failed') return null
  const output = outputOf(update.result)
  return (
    <Notice
      variant="error"
      title={t('hosts.page.kettu.failedTitle', { name: host.name, version: update.version })}
      action={
        <SetButton variant="ghost" onClick={() => dismissSshUpdate(host.id)}>
          {t('common:actions.dismiss')}
        </SetButton>
      }
      more={output && <Log lines={output} error />}
    >
      {failureText(t, 'update', update.result, host, host.ssh)}
    </Notice>
  )
}

/** Reconnect now, while the host is offline or reconnecting: it tries at once. */
export function ReconnectNow({ host }: { host: HostStatus & { ssh: SshAddress } }) {
  const { t } = useTranslation('settings')
  const updating = useHostsStore((s) => s.sshUpdates[host.id]?.state === 'updating')
  const [trying, setTrying] = useState(false)
  const [failed, setFailed] = useState<Failed | null>(null)
  const { state } = host.connection
  if (state !== 'offline' && state !== 'connecting') return null
  const reconnect = async (): Promise<void> => {
    setTrying(true)
    setFailed(null)
    const result = await window.kettu.hosts.reconnect(host.id).catch(thrown)
    setTrying(false)
    if (!result.ok) setFailed(result)
  }
  return (
    <>
      {failed && (
        <span role="alert" className="k-error" data-wrap="">
          {failureText(t, 'reconnect', failed, host, host.ssh)}
        </span>
      )}
      <SetButton loading={trying} disabled={trying || updating} onClick={() => void reconnect()}>
        {t('hosts.page.ssh.reconnect')}
      </SetButton>
    </>
  )
}

/** Change… beside the SSH address, and the dialog that moves the host to another address. */
export function ChangeSshAddress({ host }: { host: HostStatus & { ssh: SshAddress } }) {
  const { t } = useTranslation(['settings', 'common'])
  const updating = useHostsStore((s) => s.sshUpdates[host.id]?.state === 'updating')
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0)
  return (
    <>
      <SetButton
        disabled={updating}
        onClick={() => {
          setRound((n) => n + 1)
          setOpen(true)
        }}
      >
        {t('hosts.page.ssh.change')}
      </SetButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <SettingsDialogContent>
          <ChangeBody key={round} host={host} onDone={() => setOpen(false)} />
        </SettingsDialogContent>
      </Dialog>
    </>
  )
}

function ChangeBody({
  host,
  onDone,
}: {
  host: HostStatus & { ssh: SshAddress }
  onDone: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [view, setView] = useState<'form' | 'config'>('form')
  const [draft, setDraftState] = useState<SshDraft>(() => draftOf(host.ssh))
  const [config, setConfig] = useState<SshConfigHosts | null>(null)
  const [saving, setSaving] = useState<SshAddress | null>(null)
  const [failed, setFailed] = useState<{ result: Failed; address: SshAddress } | null>(null)
  const address = draftAddress(draft)
  const unchanged =
    address !== null &&
    address.target === host.ssh.target &&
    address.sshPort === host.ssh.sshPort &&
    address.identityFile === host.ssh.identityFile
  const setDraft = (next: SshDraft): void => {
    setDraftState(next)
    setFailed(null)
  }
  const save = async (): Promise<void> => {
    if (!address || unchanged || saving) return
    setSaving(address)
    setFailed(null)
    const result = await window.kettu.hosts.changeSsh(host.id, address).catch(thrown)
    setSaving(null)
    if (result.ok) onDone()
    else setFailed({ result, address })
  }
  const pickConfig = (): void => {
    setView('config')
    if (config) return
    window.kettu.hosts.sshConfig().then(setConfig, (error: unknown) =>
      setConfig({
        state: 'failed',
        reason: 'unreadable',
        path: '~/.ssh/config',
        detail: errorMessage(error),
      }),
    )
  }
  if (view === 'config') {
    return (
      <ConfigPicker
        host={host}
        config={config}
        onPick={(alias) => {
          setDraft(draftOf({ target: alias }))
          setView('form')
        }}
        onBack={() => setView('form')}
      />
    )
  }
  const output = failed && outputOf(failed.result)
  return (
    <>
      <SettingsDialogHeader title={t('hosts.page.ssh.changeTitle', { name: host.name })}>
        {t('hosts.page.ssh.changeBody', { name: host.name })}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SshAddressFields
          draft={draft}
          onChange={setDraft}
          working={saving !== null}
          onEnter={() => void save()}
        />
        {saving && (
          <p aria-live="polite" className="kettu-sd__hint">
            {t('hosts.page.ssh.checking', { target: saving.target, name: host.name })}
          </p>
        )}
        {failed && (
          <div role="alert" className="kettu-sd__stack">
            <p className="kettu-sd__error" data-selectable="">
              {failureText(t, 'address', failed.result, host, failed.address)}
            </p>
            {output && <Log lines={output} error />}
          </div>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          <SetButton variant="ghost" disabled={saving !== null} onClick={pickConfig}>
            {t('hosts.page.ssh.fromConfig')}
          </SetButton>
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          loading={saving !== null}
          disabled={!address || unchanged || saving !== null}
          onClick={() => void save()}
        >
          {t('hosts.page.save')}
        </SetButton>
      </SettingsDialogFooter>
    </>
  )
}

/** The machines of the user's SSH config to pick the new address from: the alias fills the form. */
function ConfigPicker({
  host,
  config,
  onPick,
  onBack,
}: {
  host: HostStatus
  config: SshConfigHosts | null
  onPick: (alias: string) => void
  onBack: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [query, setQuery] = useState('')
  const hosts = useMemo(() => (config?.state === 'ok' ? config.hosts : []), [config])
  const shown = useMemo(() => matchMachines(hosts, query), [hosts, query])
  return (
    <>
      <SettingsDialogHeader title={t('hosts.page.ssh.changeTitle', { name: host.name })}>
        {t('hosts.page.ssh.pickBody', { name: host.name })}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        {hosts.length > FILTER_FROM && (
          <FindField
            value={query}
            onChange={setQuery}
            label={t('hosts.add.ssh.config.filter')}
            clearLabel={t('hosts.add.ssh.config.clearFilter')}
          />
        )}
        <MachineList
          config={config}
          shown={shown}
          query={query}
          row={(machine) => (
            <PickRow key={machine.alias} machine={machine} hostId={host.id} onPick={onPick} />
          )}
        />
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          <SetButton
            variant="ghost"
            icon={<Icon icon={ArrowLeft01Icon} size={14} />}
            onClick={onBack}
          >
            {t('hosts.page.ssh.backToForm')}
          </SetButton>
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
      </SettingsDialogFooter>
    </>
  )
}

/**
 * One machine of the config: the host's own address marked as it, another host's as added, and
 * any other picked with a click.
 */
function PickRow({
  machine,
  hostId,
  onPick,
}: {
  machine: SshConfigHost
  hostId: string
  onPick: (alias: string) => void
}) {
  const { t } = useTranslation('settings')
  const current = machine.hostId === hostId
  const taken = machine.hostId !== undefined && !current
  const text = (
    <span className="ui-sg-label">
      <b className="k-name">{machine.alias}</b>
      <small className="k-mono" data-selectable="">
        {machineLine(t, machine)}
      </small>
    </span>
  )
  return (
    <li className="kettu-sd__machine" data-state={current ? 'added' : 'idle'}>
      <span className="kettu-sd__machine-line">
        <span aria-hidden className="kettu-sd__machine-mark">
          {current ? (
            <Icon icon={Tick02Icon} size={14} />
          ) : (
            <span className="kettu-sd__step-ring" />
          )}
        </span>
        <span className="kettu-sd__machine-text">{text}</span>
        {current || taken ? (
          <span className="kettu-sd__hint">
            {t(current ? 'hosts.page.ssh.current' : 'hosts.add.ssh.config.added')}
          </span>
        ) : (
          <SetButton
            aria-label={t('hosts.page.ssh.useAlias', { alias: machine.alias })}
            onClick={() => onPick(machine.alias)}
          >
            {t('hosts.page.ssh.use')}
          </SetButton>
        )}
      </span>
    </li>
  )
}

/** Where the daemon keeps its sessions and settings there, as it names the folder by default. */
function dataFolder(platform: string): string {
  return platform === 'darwin'
    ? '~/Library/Application Support/Kettu Daemon'
    : '~/.local/share/kettu'
}

/**
 * Removing a host added over SSH: from this computer alone, or with Kettu uninstalled there and,
 * only then, its sessions and settings deleted too. Uninstalling names the turns it stops and
 * that the other devices lose the host; when it fails, removing without it is offered.
 */
export function RemoveSshHost({
  host,
  onRemoved,
}: {
  host: HostStatus & { ssh: SshAddress }
  onRemoved: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const updating = useHostsStore((s) => s.sshUpdates[host.id]?.state === 'updating')
  const [open, setOpen] = useState(false)
  const [uninstall, setUninstall] = useState(false)
  const [data, setData] = useState(false)
  const [busy, setBusy] = useState<'remove' | 'uninstall' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<Failed | null>(null)
  const work = useHostWork(host, open && uninstall)
  const name = host.name
  const reset = (): void => {
    setUninstall(false)
    setData(false)
    setBusy(null)
    setError(null)
    setFailed(null)
  }
  const removeHere = async (): Promise<void> => {
    setBusy('remove')
    setError(null)
    try {
      const failure = await window.kettu.hosts.remove(host.id)
      if (failure) {
        setError(t(`hosts.failed.${failure}`, { name }))
        return setBusy(null)
      }
    } catch (e) {
      setError(errorMessage(e))
      return setBusy(null)
    }
    setOpen(false)
    onRemoved()
  }
  const uninstallThere = async (): Promise<void> => {
    setBusy('uninstall')
    setError(null)
    setFailed(null)
    const result = await window.kettu.hosts.uninstall(host.id, data).catch(thrown)
    if (!result.ok) {
      setFailed(result)
      return setBusy(null)
    }
    setOpen(false)
    onRemoved()
  }
  const output = failed && outputOf(failed)
  return (
    <>
      <DangerButton
        disabled={updating}
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        {t('hosts.page.remove.button')}
      </DangerButton>
      <AlertDialog open={open} onOpenChange={(next) => busy === null && setOpen(next)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('hosts.page.remove.title', { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {uninstall
                ? t('hosts.page.uninstall.body', { name })
                : t('hosts.page.remove.body', { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Option
              checked={uninstall}
              disabled={busy !== null}
              onChange={(on) => {
                setUninstall(on)
                if (!on) setData(false)
                setFailed(null)
              }}
              title={t('hosts.page.uninstall.option', { name })}
              hint={t('hosts.page.uninstall.optionHint')}
            />
            {uninstall && (
              <Option
                nested
                checked={data}
                disabled={busy !== null}
                onChange={(on) => {
                  setData(on)
                  setFailed(null)
                }}
                title={t('hosts.page.uninstall.data')}
                hint={t('hosts.page.uninstall.dataHint', {
                  name,
                  folder: dataFolder(host.platform),
                })}
              />
            )}
          </div>
          {uninstall && work && work.turns.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-secondary">
                {t('hosts.page.uninstall.turns', { name, count: work.turns.length })}
              </p>
              <WorkList items={work.turns} />
            </div>
          )}
          {failed && (
            <div role="alert" className="flex flex-col gap-1.5">
              <p className="text-xs text-danger" data-selectable="">
                {failureText(t, 'uninstall', failed, host, host.ssh)}
              </p>
              {output && (
                <pre
                  data-selectable=""
                  aria-label={t('hosts.add.ssh.output')}
                  className="max-h-40 overflow-auto rounded-lg bg-code-block p-2 font-mono text-code leading-4.5 whitespace-pre-wrap text-secondary"
                >
                  {output.join('\n')}
                </pre>
              )}
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            {failed && (
              <Button
                variant="outline"
                size="dialog"
                disabled={busy !== null}
                onClick={() => void removeHere()}
              >
                {t('hosts.page.uninstall.removeOnly')}
              </Button>
            )}
            <AlertDialogAction
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void (uninstall ? uninstallThere() : removeHere())}
            >
              {busy === 'uninstall'
                ? t('hosts.page.uninstall.working')
                : failed
                  ? t('hosts.add.retry')
                  : uninstall
                    ? t('hosts.page.uninstall.confirm')
                    : t('hosts.page.remove.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Option({
  nested,
  checked,
  disabled,
  onChange,
  title,
  hint,
}: {
  /** Drawn under the option it depends on. */
  nested?: boolean
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
  title: string
  hint: string
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-code bg-subtle px-3 py-2.5 text-left',
        nested && 'ml-6',
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <span className="flex flex-col gap-px">
        <span className="text-ui font-medium text-primary">{title}</span>
        <span className="text-xs text-secondary">{hint}</span>
      </span>
    </label>
  )
}
