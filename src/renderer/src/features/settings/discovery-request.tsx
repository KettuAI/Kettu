// A device of the same Kettu account asks to be added, in whatever window is open: to this
// window's own host, or, in the desktop app, to another host it connects to. Its owner compares the
// code and adds it or not; the first answer anywhere counts. Requests of one batch from hosts this
// window may all use are asked as one, under the batch's code.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLocale } from '@renderer/lib/i18n'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import {
  groupCodeOf,
  type DiscoveryEnd,
  type DiscoveryRequestEvent,
  type DiscoveryRequestState,
  type PairGroup,
  type PairTranscript,
} from '@shared/remote/discovery'
import type { JoinedDevice } from '@shared/remote/host-admin'
import { css as generalCss } from '@renderer/components/affect/settings-general'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import { Dialog } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { countdown } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { useSeconds } from '@renderer/lib/use-now'
import { otherHosts, useHostsStore } from '@renderer/stores/hosts'
import { SetButton, Spin } from './controls'
import { askRemoveDevice } from './device-remove'
import { PairCode } from './host-account'
import { onHostRequests } from './host-requests'
import { closeRequest } from './pair-close'
import { DeviceIcon, DeviceTile } from './remote-parts'
import { deviceLine } from './remote-text'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

type Asking = Extract<DiscoveryRequestState, { state: 'confirm' }>

/** A request that waits, on this window's own host (`hostId` null) or another one. */
interface Entry {
  key: string
  hostId: string | null
  requestId: number
  request: Asking
}

/** What the dialog asks about: one request, or every request of one batch. */
type Shown = { entries: Entry[]; group: PairGroup | null }

/** Ends worth a word once the dialog is gone; Add and Don't add were the owner's own. */
type QuietEnd = Exclude<DiscoveryEnd, 'added' | 'rejected'>

const keyOf = (hostId: string | null, requestId: number): string => `${hostId ?? ''}:${requestId}`

function answerOn(entry: Entry, add: boolean, name: string): Promise<'gone' | null> {
  const { hostId, requestId } = entry
  if (hostId === null) return window.kettu.remote.answerDiscovery(requestId, add, name)
  return window.kettu.hosts.request(hostId, 'remote.answerDiscovery', {
    requestId,
    add,
    name,
  }) as Promise<'gone' | null>
}

/** Another host's name as this computer knows it, or null for one it does not. */
function hostNamed(hostId: string): string | null {
  return otherHosts(useHostsStore.getState()).find((host) => host.id === hostId)?.name ?? null
}

/**
 * The requests to ask about first: a batch whose every host this window may use and holds a
 * request of, or else the oldest request alone.
 */
function nextShown(entries: Entry[], relayIds: ReadonlyMap<string, string>): Shown | null {
  const first = entries[0]
  if (!first) return null
  for (const entry of entries) {
    const group = entry.request.group
    if (!group || entry.hostId === null) continue
    const batch = group.hosts.map((relayId) =>
      entries.find(
        (other) =>
          other.hostId !== null &&
          other.request.group?.id === group.id &&
          relayIds.get(other.hostId) === relayId,
      ),
    )
    if (batch.every((found) => found !== undefined)) return { entries: batch as Entry[], group }
  }
  return { entries: [first], group: null }
}

/** Mounted once for the window: shows each request as it comes, and those already waiting. */
export function DiscoveryRequestDialog() {
  const { t } = useTranslation('settings')
  const [entries, setShownEntries] = useState<Entry[]>([])
  // The same, for the handlers, which read and change it outside a render.
  const held = useRef<Entry[]>([])
  const setEntries = (change: (now: Entry[]) => Entry[]): void => {
    held.current = change(held.current)
    setShownEntries(held.current)
  }
  // The requests answered here, whose end needs no word of where they were answered.
  const answered = useRef(new Map<string, 'add' | 'reject'>())
  const answerRef = useRef<((add: boolean) => void) | null>(null)
  const [ownName, setOwnName] = useState<string | null>(null)
  // The dialog itself takes focus, so no button shows a ring nor is pressed by a stray Enter.
  const popup = useRef<HTMLDivElement>(null)
  const hosts = useHostsStore((s) => s.status?.hosts ?? null)
  const relayIds = useMemo(
    () =>
      new Map(
        (hosts ?? []).flatMap((host) => (host.relay ? [[host.id, host.relay.id] as const] : [])),
      ),
    [hosts],
  )

  useEffect(() => {
    let live = true
    const take = (hostId: string | null, { requestId, request }: DiscoveryRequestEvent): void => {
      const key = keyOf(hostId, requestId)
      if (request.state === 'confirm') {
        setEntries((now) => {
          const at = now.findIndex((entry) => entry.key === key)
          const entry = { key, hostId, requestId, request }
          if (at < 0) return [...now, entry]
          return now.map((kept, index) => (index === at ? entry : kept))
        })
        return
      }
      const gone = held.current.find((entry) => entry.key === key)
      if (!gone) return
      setEntries((now) => now.filter((entry) => entry.key !== key))
      {
        const mine = answered.current.get(key)
        answered.current.delete(key)
        const name = gone.request.device.name
        const { reason, answeredOn } = request
        const place = answeredOn ?? (hostId === null ? null : hostNamed(hostId))
        if (mine === 'add' && reason === 'added') {
          toast(t('remote.pair.added', { name }))
        } else if (mine) {
          // Turned down here, or ended while the answer was on its way.
          if (reason !== 'added' && reason !== 'rejected') quietEnd(reason, name)
        } else if ((reason === 'added' || reason === 'rejected') && place) {
          toast(t(`remote.discovery.answeredOn.${reason}`, { name, place }), undefined, {
            tone: 'info',
          })
        } else if (reason !== 'added' && reason !== 'rejected') {
          quietEnd(reason, name)
        }
      }
    }
    const quietEnd = (reason: QuietEnd, name: string): void => {
      toast(t(`remote.discovery.ended.${reason}`, { name }), undefined, { tone: 'info' })
    }
    const joined = (hostId: string | null, device: JoinedDevice, host: string): void => {
      toast(
        t('remote.joined.toast', { name: device.name, host }),
        { label: t('remote.joined.remove'), onClick: () => askRemoveDevice(hostId, device.id) },
        { duration: 10_000 },
      )
    }
    const offOwn = window.kettu.remote.onDiscovery((event) => take(null, event))
    window.kettu.remote
      .pendingDiscovery()
      .then((pending) => {
        if (live && pending) take(null, pending)
      })
      .catch((error: unknown) => console.error('Could not read the discovery request', error))
    let ownHostName: string | null = null
    if (isWeb) {
      window.kettu.remote
        .status()
        .then((status) => {
          if (!live) return
          ownHostName = status.hostName
          setOwnName(status.hostName)
        })
        .catch(() => {})
    }
    const offJoined = window.kettu.remote.onDeviceJoined(({ device }) =>
      joined(null, device, ownHostName ?? ''),
    )
    const offHosts = isWeb
      ? () => {}
      : onHostRequests({
          discovery: take,
          joined: (hostId, { device }) => joined(hostId, device, hostNamed(hostId) ?? ''),
          opened: (hostId) => {
            window.kettu.hosts
              .request(hostId, 'remote.pendingDiscovery', undefined)
              .then((pending) => {
                if (live && pending) take(hostId, pending as DiscoveryRequestEvent)
              })
              // A host before these answers nothing; its requests come as events.
              .catch(() => {})
          },
          // What it asked can no longer be answered here.
          closed: (hostId) => setEntries((now) => now.filter((entry) => entry.hostId !== hostId)),
        })
    return () => {
      live = false
      offOwn()
      offJoined()
      offHosts()
    }
    // One subscription for the window; t only words the toasts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shown = nextShown(entries, relayIds)
  const shownKey = shown?.entries.map((entry) => entry.key).join(' ') ?? ''
  const hostOf = (entry: Entry): string | null =>
    entry.hostId === null
      ? isWeb
        ? ownName
        : null
      : (hosts?.find((host) => host.id === entry.hostId)?.name ?? null)

  return (
    <Dialog
      open={shown !== null}
      onOpenChange={(next, details) => {
        if (next) return
        // It needs an answer: a click outside keeps it, Esc or the close button is Don't add.
        if (closeRequest(true, details.reason) === 'reject') answerRef.current?.(false)
      }}
    >
      <SettingsDialogContent ref={popup} initialFocus={popup} className="sm:max-w-110">
        {/* Asked over any screen, so it brings the settings sheets its parts are drawn with. */}
        <style href="ui-settings-general" precedence="default">
          {generalCss}
        </style>
        <style href="ui-settings-security" precedence="default">
          {securityCss}
        </style>
        {shown && (
          <DiscoveryConfirm
            key={shownKey}
            shown={shown}
            hosts={shown.entries.map(hostOf)}
            answerRef={answerRef}
            onAnswered={(entry, add) => answered.current.set(entry.key, add ? 'add' : 'reject')}
            onGone={(entry) => {
              answered.current.delete(entry.key)
              setEntries((now) => now.filter((kept) => kept.key !== entry.key))
            }}
            onRejected={(gone) => {
              const keys = new Set(gone.map((entry) => entry.key))
              setEntries((now) => now.filter((entry) => !keys.has(entry.key)))
            }}
          />
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

function DiscoveryConfirm({
  shown: { entries, group },
  hosts,
  answerRef,
  onAnswered,
  onGone,
  onRejected,
}: {
  shown: Shown
  /** Each request's host by name, null for this computer. */
  hosts: (string | null)[]
  answerRef: { current: ((add: boolean) => void) | null }
  onAnswered: (entry: Entry, add: boolean) => void
  /** It was answered elsewhere first, or ended. */
  onGone: (entry: Entry) => void
  /** Turned down here: the dialog moves on without waiting for the hosts. */
  onRejected: (entries: Entry[]) => void
}) {
  const { t } = useTranslation('settings')
  const first = entries[0]!
  const { device, expiresAt } = first.request
  const [name, setName] = useState(device.name)
  const [answering, setAnswering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS
  const confirmed = entries.every((entry) => entry.request.deviceConfirmed)
  const code = useGroupCode(group, entries) ?? (group ? null : first.request.code)
  const soonest = Math.min(...entries.map((entry) => entry.request.expiresAt))

  const answer = (add: boolean): void => {
    if (answering || (add && (!valid || !confirmed))) return
    setAnswering(true)
    setError(null)
    const named = add ? trimmed : ''
    for (const entry of entries) onAnswered(entry, add)
    if (!add) onRejected(entries)
    void Promise.allSettled(
      entries.map((entry) =>
        answerOn(entry, add, named).then((result) => {
          if (result !== 'gone') return
          onGone(entry)
          toast(t('remote.discovery.gone', { name: device.name }), undefined, { tone: 'info' })
        }),
      ),
    ).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      // Don't add closed the dialog already; a request ends on its own when it expires.
      if (!add || !failed) return
      setAnswering(false)
      setError(errorMessage(failed.reason))
    })
  }
  useEffect(() => {
    answerRef.current = answer
    return () => {
      answerRef.current = null
    }
  })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    answer(true)
  }
  const named = hosts.filter((host): host is string => host !== null)
  const body = group
    ? t('remote.discovery.groupBody', {
        name: device.name,
        hosts: new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(named),
      })
    : named[0]
      ? t('remote.discovery.bodyOn', { name: device.name, host: named[0] })
      : t('remote.discovery.body', { name: device.name })
  return (
    <form className="contents" onSubmit={submit}>
      <SettingsDialogHeader
        title={
          group
            ? t('remote.discovery.groupTitle', { count: entries.length })
            : t('remote.discovery.title')
        }
      >
        {body}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <div className="k-inset kettu-sd__row kettu-sd__device">
          <DeviceTile large icon={<DeviceIcon device={device} />} />
          <span className="ui-sg-label">
            <b className="k-name">{device.name}</b>
            <small>
              {device.known
                ? `${deviceLine(t, device)} · ${t('remote.discovery.known')}`
                : deviceLine(t, device)}
            </small>
          </span>
        </div>
        <div className="kettu-sd__stack kettu-sd__compare">
          <PairCode code={code} />
          <p className="kettu-sd__hint">
            {group
              ? t('remote.discovery.groupCheck', { name: device.name })
              : t('remote.discovery.check')}
          </p>
        </div>
        <SettingsField
          label={t('remote.pair.confirm.name')}
          htmlFor="discovery-name"
          hint={
            error ? (
              <span role="alert" className="kettu-sd__error">
                {error}
              </span>
            ) : (
              t('remote.pair.confirm.nameHint')
            )
          }
        >
          <input
            id="discovery-name"
            value={name}
            autoComplete="off"
            spellCheck={false}
            className={DIALOG_FIELD}
            aria-invalid={!valid || undefined}
            disabled={answering}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          !confirmed ? (
            // Add waits until the device's user said the codes match.
            <span role="status" className="kettu-sd__status">
              <Spin />
              {t('remote.discovery.waiting', { name: device.name })}
            </span>
          ) : (
            <ExpiresIn expiresAt={Number.isFinite(soonest) ? soonest : expiresAt} />
          )
        }
      >
        <SetButton
          size="md"
          type="button"
          variant="ghost"
          disabled={answering}
          onClick={() => answer(false)}
        >
          {t('remote.discovery.reject')}
        </SetButton>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          loading={answering}
          disabled={!valid || !confirmed || answering}
        >
          {t('remote.pair.confirm.add')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** A batch's code from its requests' transcripts, in the batch's order; null until worked out. */
function useGroupCode(group: PairGroup | null, entries: Entry[]): string | null {
  const [code, setCode] = useState<{ of: string; code: string | null } | null>(null)
  const transcripts = useMemo(() => {
    if (!group) return null
    const byRelay = new Map<string, PairTranscript>()
    entries.forEach((entry, index) => byRelay.set(group.hosts[index]!, entry.request.transcript))
    return byRelay
  }, [group, entries])
  const of = group ? `${group.id} ${JSON.stringify([...(transcripts ?? [])])}` : ''
  useEffect(() => {
    if (!group || !transcripts) return
    let live = true
    void groupCodeOf(group.hosts, transcripts).then((worked) => {
      if (live) setCode({ of, code: worked })
    })
    return () => {
      live = false
    }
  }, [group, transcripts, of])
  return code?.of === of ? code.code : null
}

/** How long is left to answer, quietly at the footer's start. */
function ExpiresIn({ expiresAt }: { expiresAt: number }) {
  const { t } = useTranslation('settings')
  const now = useSeconds()
  return (
    <span className="k-num">
      {t('remote.pair.expiresIn', { time: countdown(expiresAt - now) })}
    </span>
  )
}
