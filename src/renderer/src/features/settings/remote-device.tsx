import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Edit02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { DeviceActivity } from '@shared/remote/activity'
import type { PairedDevice } from '@shared/remote/device'
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
import { basename, monthDay } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSettingsItem } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import { Fact } from './agent-parts'
import { CONFIRM, ControlError, DangerButton, IconAction, Pill, Spin } from './controls'
import { DeviceIcon, DeviceTile } from './remote-parts'
import { ThisBrowserBadge } from './remote-section'
import { changeDevice, deviceLine, nextDeviceName, whenAt } from './remote-text'
import { GroupLabel, ItemPageHeader, RowFrame, RowGroup, RowText } from './rows'

const back = () => openSettingsItem('remote', null)

/** A paired device's page: when it joined and last connected, what it did, and removing it. */
export function DevicePage({ id }: { id: string }) {
  const { useRemoteStore } = useHostScope()
  const { t } = useTranslation('settings')
  const device = useRemoteStore((s) => s.status?.devices.find((entry) => entry.id === id) ?? null)
  const online = useRemoteStore((s) => s.status?.online.includes(id) ?? false)
  if (!device) {
    return (
      <>
        <ItemPageHeader
          back={t('sections.remote')}
          onBack={back}
          item={id}
          icon={null}
          title={null}
        />
        <p className="ui-sg-hint">{t('remote.device.gone')}</p>
      </>
    )
  }
  return <DevicePageBody device={device} online={online} />
}

function DevicePageBody({ device, online }: { device: PairedDevice; online: boolean }) {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const now = useNow()
  const events = useActivity(device)
  // The latest pairing, as the activity of the last 30 days still holds it.
  const paired = events?.find((event) => event.kind === 'paired')
  const joined = t(
    paired?.via === 'account'
      ? 'remote.device.joinedAccount'
      : device.kind === 'desktop'
        ? 'remote.device.joinedLink'
        : 'remote.device.joinedScan',
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
    <>
      <ItemPageHeader
        back={t('sections.remote')}
        onBack={back}
        item={device.id}
        icon={<DeviceTile large icon={<DeviceIcon device={device} />} />}
        title={<DeviceName device={device} />}
        subtitle={<span className="k-name">{deviceLine(t, device)}</span>}
      >
        {online && <Pill tone="success">{t('remote.devices.online')}</Pill>}
      </ItemPageHeader>

      <div className="k-groups">
        <section aria-label={t('remote.device.facts')} className="k-group">
          <RowGroup>
            <Fact name={t('remote.device.joined')}>{joined}</Fact>
            <Fact name={t('remote.device.lastConnected')}>{last}</Fact>
          </RowGroup>
        </section>
        <Activity device={device} events={events} />
        <section aria-label={t('remote.device.remove.name')} className="k-group">
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
    </>
  )
}

/** The device's activity of the last 30 days, read again when it connects or is renamed. */
function useActivity(device: PairedDevice): DeviceActivity[] | null {
  const { api } = useHostScope()
  const [events, setEvents] = useState<DeviceActivity[] | null>(null)
  useEffect(() => {
    let live = true
    api.remote
      .activity(device.id)
      .then((read) => live && setEvents(read))
      .catch(() => live && setEvents([]))
    return () => {
      live = false
    }
  }, [device.id, device.lastConnectedAt, device.name, api])
  return events
}

function Activity({ device, events }: { device: PairedDevice; events: DeviceActivity[] | null }) {
  const { t } = useTranslation('settings')
  return (
    <section aria-label={t('remote.device.activity')} className="k-group">
      <GroupLabel
        group={{
          id: 'activity',
          label: t('remote.device.activity'),
          actions: <span className="k-head-meta k-muted">{t('remote.device.days')}</span>,
        }}
      />
      {events === null ? (
        <RowGroup>
          <div className="ui-sg-row k-activity">
            <Spin />
          </div>
        </RowGroup>
      ) : events.length === 0 ? (
        <p className="ui-sg-hint">{t('remote.device.noActivity')}</p>
      ) : (
        <RowGroup>
          <ul aria-label={t('remote.device.activity')} className="k-activities">
            {events.map((event, i) => (
              <ActivityRow key={`${event.at}-${i}`} event={event} kind={device.kind} />
            ))}
          </ul>
        </RowGroup>
      )}
      <p className="ui-sg-hint">{t('remote.device.activityNote')}</p>
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
    <li className="ui-sg-row k-activity">
      <span className="k-activity__when k-num">{whenAt(t, event.at, now)}</span>
      <span className="k-activity__what">{eventText(t, event, kind, title, onHost)}</span>
      {project && <span className="k-activity__where">{project}</span>}
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
        event.via === 'account'
          ? 'remote.device.events.pairedAccount'
          : kind === 'desktop'
            ? 'remote.device.events.pairedLink'
            : 'remote.device.events.paired',
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

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** The name, edited in place. Enter or leaving the field saves; Esc puts the old name back. */
function DeviceName({ device }: { device: PairedDevice }) {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const [error, setError] = useState<string | null>(null)
  const pencil = useRef<HTMLButtonElement>(null)
  const cancel = useRef(false)
  const saving = useRef(false)
  // False before the field unmounts, so that blur does not save the name a second time.
  const live = useRef(false)
  // Enter and Esc hand focus back to the pencil; a click elsewhere keeps it where it went.
  const returnFocus = useRef(false)

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false
      pencil.current?.focus()
    }
  }, [editing])

  useEffect(
    () => () => {
      live.current = false
    },
    [],
  )

  const stop = (): void => {
    live.current = false
    setError(null)
    setEditing(false)
  }

  const commit = async (): Promise<void> => {
    if (saving.current || !live.current) return
    if (cancel.current) {
      cancel.current = false
      setDraft(device.name)
      stop()
      return
    }
    const next = nextDeviceName(device.name, draft)
    if (next === null) {
      setDraft(device.name)
      stop()
      return
    }
    saving.current = true
    const failed = await changeDevice(t, () => api.remote.renameDevice(device.id, next))
    saving.current = false
    if (!live.current) return
    if (failed) {
      setError(failed)
      return
    }
    stop()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isComposing(event) || saving.current) return
    if (event.key === 'Enter') {
      returnFocus.current = true
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      cancel.current = true
      returnFocus.current = true
      event.currentTarget.blur()
    }
  }

  return (
    <>
      <span className="k-title-edit">
        {editing ? (
          <input
            aria-label={t('remote.device.rename')}
            aria-invalid={error !== null || undefined}
            value={draft}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={256}
            className="k-title-input"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
            onBlur={() => void commit()}
            onKeyDown={onKeyDown}
          />
        ) : (
          <span className="k-name">{device.name}</span>
        )}
        {!editing && (
          <IconAction
            ref={pencil}
            label={t('remote.device.rename')}
            icon={Edit02Icon}
            onClick={() => {
              setDraft(device.name)
              setError(null)
              live.current = true
              setEditing(true)
            }}
          />
        )}
        <ThisBrowserBadge deviceId={device.id} />
      </span>
      {error && (
        <span className="k-error k-title-error" data-wrap="">
          {error}
        </span>
      )}
    </>
  )
}

function RemoveDevice({ device }: { device: PairedDevice }) {
  const { api } = useHostScope()
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
    const failed = await changeDevice(t, () => api.remote.removeDevice(device.id))
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
      <DangerButton onClick={() => setOpen(true)}>{t('remote.device.remove.button')}</DangerButton>
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
