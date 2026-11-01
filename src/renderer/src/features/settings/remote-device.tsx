import { useEffect, useState, type FormEvent } from 'react'
import { PencilIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DeviceActivity } from '@shared/remote/activity'
import { DEVICE_NAME_CHARS, type PairedDevice } from '@shared/remote/device'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { basename, monthDay } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { useNow } from '@renderer/lib/use-now'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRemoteStore } from '@renderer/stores/remote'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSettingsItem } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import { Fact } from './agent-parts'
import { CONFIRM, ControlError } from './controls'
import { DeviceIcon, DeviceTile, OnlineDot } from './remote-parts'
import { ThisBrowserBadge } from './remote-section'
import { changeDevice, deviceLine, whenAt } from './remote-text'
import { GroupLabel, ItemPageHeader, RowFrame, RowGroup, RowText } from './rows'

const back = () => openSettingsItem('remote', null)

/** A paired device's page: when it joined and last connected, what it did, and removing it. */
export function DevicePage({ id }: { id: string }) {
  const { t } = useTranslation('settings')
  const device = useRemoteStore((s) => s.status?.devices.find((entry) => entry.id === id) ?? null)
  const online = useRemoteStore((s) => s.status?.online.includes(id) ?? false)
  if (!device) {
    return (
      <div className="flex flex-col">
        <ItemPageHeader
          back={t('sections.remote')}
          onBack={back}
          item={id}
          icon={null}
          title={null}
        />
        <p className="px-1 text-small text-tertiary">{t('remote.device.gone')}</p>
      </div>
    )
  }
  return <DevicePageBody device={device} online={online} />
}

function DevicePageBody({ device, online }: { device: PairedDevice; online: boolean }) {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const now = useNow()
  const [renaming, setRenaming] = useState(false)
  const joined = t(
    device.kind === 'desktop' ? 'remote.device.joinedLink' : 'remote.device.joinedScan',
    {
      date: monthDay(device.addedAt),
    },
  )
  const last =
    device.lastConnectedAt === null
      ? t('remote.device.never')
      : online
        ? t('remote.device.onlineSince', { time: whenAt(t, device.lastConnectedAt, now) })
        : whenAt(t, device.lastConnectedAt, now)
  return (
    <div className="flex flex-col">
      <ItemPageHeader
        back={t('sections.remote')}
        onBack={back}
        item={device.id}
        icon={<DeviceTile large icon={<DeviceIcon device={device} className="size-5" />} />}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{device.name}</span>
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={t('remote.device.rename')}
              title={t('remote.device.rename')}
              className="text-tertiary"
              onClick={() => setRenaming(true)}
            >
              <PencilIcon />
            </Button>
            <ThisBrowserBadge deviceId={device.id} className="shrink-0 font-sans font-normal" />
            {online && (
              <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs font-normal text-tertiary">
                <OnlineDot />
                {t('remote.devices.online')}
              </span>
            )}
          </span>
        }
      >
        <p className="truncate text-command leading-4.5 text-tertiary">{deviceLine(t, device)}</p>
      </ItemPageHeader>
      <RenameDialog device={device} open={renaming} onOpenChange={setRenaming} />

      <div className="flex flex-col gap-7">
        <section aria-label={t('remote.device.facts')} className="flex flex-col">
          <RowGroup>
            <Fact name={t('remote.device.joined')}>{joined}</Fact>
            <Fact name={t('remote.device.lastConnected')}>{last}</Fact>
          </RowGroup>
        </section>
        <Activity device={device} />
        <section aria-label={t('remote.device.remove.name')} className="flex flex-col">
          <RowGroup>
            <RowFrame
              text={
                <RowText
                  name={t('remote.device.remove.name')}
                  description={t('remote.device.remove.description', onHost)}
                />
              }
            >
              <RemoveDevice device={device} />
            </RowFrame>
          </RowGroup>
        </section>
      </div>
    </div>
  )
}

/** The device's activity of the last 30 days, read again when it connects or is renamed. */
function Activity({ device }: { device: PairedDevice }) {
  const { t } = useTranslation('settings')
  const [events, setEvents] = useState<DeviceActivity[] | null>(null)
  useEffect(() => {
    let live = true
    window.kettu.remote
      .activity(device.id)
      .then((read) => live && setEvents(read))
      .catch(() => live && setEvents([]))
    return () => {
      live = false
    }
  }, [device.id, device.lastConnectedAt, device.name])
  return (
    <section aria-label={t('remote.device.activity')} className="flex flex-col">
      <GroupLabel
        group={{
          id: 'activity',
          label: t('remote.device.activity'),
          actions: <span className="mr-1.5 text-xs text-tertiary">{t('remote.device.days')}</span>,
        }}
      />
      {events === null ? (
        <RowGroup>
          <div className="flex h-10 items-center px-4">
            <Spinner className="size-3.5 text-icon" />
          </div>
        </RowGroup>
      ) : events.length === 0 ? (
        <p className="px-1 py-0.5 text-small text-tertiary">{t('remote.device.noActivity')}</p>
      ) : (
        <RowGroup>
          <ul aria-label={t('remote.device.activity')}>
            {events.map((event, i) => (
              <ActivityRow key={`${event.at}-${i}`} event={event} kind={device.kind} />
            ))}
          </ul>
        </RowGroup>
      )}
      <p className="mt-2.5 px-1 text-xs text-pretty text-tertiary">
        {t('remote.device.activityNote')}
      </p>
    </section>
  )
}

export function ActivityRow({ event, kind }: { event: DeviceActivity; kind: string }) {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const now = useNow()
  const sessionId = 'sessionId' in event ? event.sessionId : null
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  // A session's project, or a terminal's.
  const projectPath =
    'projectPath' in event
      ? event.projectPath
      : summary && !summary.scratch
        ? summary.projectPath
        : null
  const project = useProjectsStore((s) =>
    projectPath
      ? (s.projects.find((p) => p.path === projectPath)?.name ?? basename(projectPath))
      : null,
  )
  // The title the session had then, which a later rename does not change.
  const title = 'title' in event ? event.title : null
  return (
    <li className="relative flex h-10 items-center gap-4 px-4 before:absolute before:top-0 before:right-0 before:left-4 before:h-(--hairline) before:bg-border-soft first:before:hidden">
      <span className="w-28 shrink-0 truncate text-xs text-tertiary tabular">
        {whenAt(t, event.at, now)}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui">
        {eventText(t, event, kind, title, onHost)}
      </span>
      {project && <span className="shrink-0 text-xs text-tertiary">{project}</span>}
    </li>
  )
}

function eventText(
  t: ReturnType<typeof useTranslation<'settings'>>['t'],
  event: DeviceActivity,
  kind: string,
  title: string | null,
  onHost: ReturnType<typeof useHostContext>,
): string {
  switch (event.kind) {
    case 'paired':
      return t(
        kind === 'desktop' ? 'remote.device.events.pairedLink' : 'remote.device.events.paired',
        onHost,
      )
    case 'connected':
      return t('remote.device.events.connected')
    case 'renamed':
      return t(
        event.by === 'device'
          ? 'remote.device.events.renamedOnDevice'
          : 'remote.device.events.renamed',
        { from: event.from, to: event.to },
      )
    case 'removed':
      return t(
        event.by === 'unseen'
          ? 'remote.device.events.removedUnseen'
          : event.by === 'reset'
            ? 'remote.device.events.removedReset'
            : 'remote.device.events.removed',
      )
    case 'session-created':
      return title
        ? t('remote.device.events.sessionCreated', { title })
        : t('remote.device.events.sessionCreatedUnknown')
    case 'session-archived':
      return title
        ? t('remote.device.events.sessionArchived', { title })
        : t('remote.device.events.sessionArchivedUnknown')
    case 'session-deleted':
      return title
        ? t('remote.device.events.sessionDeleted', { title })
        : t('remote.device.events.sessionDeletedUnknown')
    case 'terminal-opened':
      return t('remote.device.events.terminalOpened')
    case 'terminal-closed':
      return t('remote.device.events.terminalClosed')
  }
}

function RenameDialog({
  device,
  open,
  onOpenChange,
}: {
  device: PairedDevice
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState(device.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (trimmed === device.name) return onOpenChange(false)
    setBusy(true)
    const failed = await changeDevice(t, () => window.kettu.remote.renameDevice(device.id, trimmed))
    setBusy(false)
    if (failed) setError(failed)
    else onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(device.name)
        setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('remote.device.renameTitle')}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={!valid || error !== null || undefined}>
            <FieldLabel htmlFor="device-rename" className="sr-only">
              {t('remote.pair.confirm.name')}
            </FieldLabel>
            <Input
              id="device-rename"
              value={name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!valid || error !== null || undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" disabled={!valid || busy}>
              {t('remote.device.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveDevice({ device }: { device: PairedDevice }) {
  const { t } = useTranslation(['settings', 'common'])
  const onHost = useHostContext()
  // The web client removing its own browser ends this page's connection for good.
  const own = useWebHostStore((s) => s.host?.device.id === device.id)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = await changeDevice(t, () => window.kettu.remote.removeDevice(device.id))
    if (failed) {
      setError(failed)
      setBusy(false)
      return
    }
    setOpen(false)
    back()
  }
  return (
    <>
      <ControlError error={open ? null : error} />
      <Button variant="destructive-outline" size="sm" onClick={() => setOpen(true)}>
        {t('remote.device.remove.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {own
                ? t('remote.web.removeTitle')
                : t('remote.device.remove.title', { name: device.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {own ? t('remote.web.removeBody') : t('remote.device.remove.body', onHost)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {t('remote.device.remove.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
