// Pairing with the account's other computers: the list in Settings › Hosts and Add host, and the
// dialog that compares the code both screens show.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { currentLocale } from '@renderer/lib/i18n'
import {
  groupCodeOf,
  newPairGroup,
  type AccountComputer,
  type DiscoveredHost,
  type DiscoveredHosts,
  type PairTranscript,
} from '@shared/remote/discovery'
import type {
  HostPairingFailure,
  HostPairingState,
  HostStatus,
  ReverseOutcome,
} from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog } from '@renderer/components/ui/dialog'
import { mediumAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { signIn } from '@renderer/stores/account'
import { connectTo, loadDiscovered, useHostsStore } from '@renderer/stores/hosts'
import { useSettingsStore } from '@renderer/stores/settings'
import { IconAction, Pill, SetButton, Skel, Spin } from './controls'
import { Added } from './host-added'
import { platformName } from './host-text'
import { closeRequest } from './pair-close'
import { DeviceTile, HostIcon } from './remote-parts'
import { useDiscoveredHosts, useRereadDiscovered } from './use-discovered'
import { EmptyRow, ItemLine, RowLine, RowText, Thing } from './rows'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'

/** One of the account's hosts in Settings › Hosts, with Connect at its end. */
export function AccountHostRow({ host }: { host: DiscoveredHost }) {
  const { t } = useTranslation('settings')
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<DeviceTile icon={<HostIcon platform={host.platform} />} />}
        name={<span className="k-name">{host.name}</span>}
      >
        <ItemLine>{platformName(host.platform)}</ItemLine>
      </Thing>
      <span className="ui-sg-control">
        <SetButton
          aria-label={t('hosts.account.connectTo', { name: host.name })}
          onClick={() => connectTo(host)}
        >
          {t('hosts.account.connect')}
        </SetButton>
      </span>
    </div>
  )
}

/**
 * One of the account's computers that cannot be connected from here now, and why: added already,
 * remote access off there, or offline since it was last seen.
 */
export function AccountComputerRow({ computer }: { computer: AccountComputer }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const system = computer.platform ? platformName(computer.platform) : null
  const line =
    computer.state === 'remote_off'
      ? t('hosts.account.computer.remoteOffHint')
      : computer.state === 'offline' && computer.lastSeenAt !== undefined
        ? [
            system,
            t('hosts.account.computer.lastSeen', { ago: mediumAgo(computer.lastSeenAt, now) }),
          ]
            .filter(Boolean)
            .join(' · ')
        : system
  const end =
    computer.state === 'added' ? (
      <Pill tone="success">{t('hosts.account.computer.added')}</Pill>
    ) : computer.state === 'remote_off' ? (
      <Pill tone="warning">{t('hosts.account.computer.remoteOff')}</Pill>
    ) : (
      <Pill>{t('hosts.state.offline')}</Pill>
    )
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<DeviceTile icon={<HostIcon platform={computer.platform} />} />}
        name={<span className="k-name">{computer.name}</span>}
      >
        {computer.state === 'remote_off' ? (
          <small data-wrap="">{line}</small>
        ) : (
          line && <ItemLine>{line}</ItemLine>
        )}
      </Thing>
      <span className="ui-sg-control">{end}</span>
    </div>
  )
}

/** In place of the account's hosts: loading, none yet, signed out, or the relay out of reach. */
export function AccountHostsState({ discovered }: { discovered: DiscoveredHosts | null }) {
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  if (discovered === null) {
    return (
      <div className="ui-sg-row" aria-busy="true">
        <span className="k-thing">
          <span className="k-mark">
            <Skel width={24} className="k-skel--mark" />
          </span>
          <span className="ui-sg-label k-lines">
            <Skel width={132} />
            <Skel width={64} />
          </span>
        </span>
      </div>
    )
  }
  if (discovered.state === 'signed_out') {
    return (
      <RowLine
        text={
          <RowText
            name={t('hosts.account.signedOut.title')}
            description={t('hosts.account.signedOut.body')}
          />
        }
      >
        <SetButton onClick={() => void signIn()}>{t('account.signIn')}</SetButton>
      </RowLine>
    )
  }
  if (discovered.state === 'unavailable') {
    return (
      <RowLine
        text={
          <RowText
            name={t('hosts.account.unavailable.title')}
            description={t('hosts.account.unavailable.body')}
          />
        }
      >
        <SetButton
          loading={refresh.phase === 'turning'}
          icon={<Icon icon={RefreshIcon} size={14} />}
          onClick={() => void refresh.run(loadDiscovered)}
        >
          {t('hosts.add.retry')}
        </SetButton>
      </RowLine>
    )
  }
  return <EmptyRow title={t('hosts.account.empty.title')} hint={t('hosts.account.empty.body')} />
}

/** The account group's heading actions: list again, and the pairing dialog Connect opens. */
export function AccountHostsActions({ signedOut }: { signedOut: boolean }) {
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  const listed = useHostsStore((s) => (s.discovered?.state === 'ok' ? s.discovered.hosts : null))
  // Drawn only while Settings shows the list.
  useRereadDiscovered()
  return (
    <>
      {listed && listed.length > 1 && (
        <SetButton
          aria-label={t('hosts.account.connectAllLabel', { count: listed.length })}
          onClick={() => connectTo(listed)}
        >
          {t('hosts.account.connectAll')}
        </SetButton>
      )}
      {!signedOut && (
        <IconAction
          label={t('hosts.account.refresh')}
          icon={refresh.phase === 'done' ? Tick02Icon : RefreshIcon}
          busy={refresh.phase === 'turning'}
          onClick={() => void refresh.run(loadDiscovered)}
        />
      )}
      <ConnectHostDialog />
    </>
  )
}

/**
 * The account's hosts at the top of Add host, once there are any; Connect pairs within the
 * dialog.
 */
export function AccountHostsPicker({
  onConnect,
}: {
  onConnect: (host: DiscoveredHost | DiscoveredHost[]) => void
}) {
  const { t } = useTranslation('settings')
  const discovered = useDiscoveredHosts()
  const now = useNow()
  useRereadDiscovered()
  if (discovered?.state !== 'ok') return null
  const others = (discovered.computers ?? []).filter((computer) => computer.state !== 'added')
  if (discovered.hosts.length === 0 && others.length === 0) return null
  return (
    <section aria-labelledby="account-hosts-label" className="kettu-sd__field">
      <div className="flex items-center justify-between gap-3">
        <h3 id="account-hosts-label" className="kettu-sd__label">
          {t('hosts.account.group')}
        </h3>
        {discovered.hosts.length > 1 && (
          <SetButton
            aria-label={t('hosts.account.connectAllLabel', { count: discovered.hosts.length })}
            onClick={() => onConnect(discovered.hosts)}
          >
            {t('hosts.account.connectAll')}
          </SetButton>
        )}
      </div>
      <ul className="kettu-sd__list kettu-sd__account">
        {discovered.hosts.map((host) => (
          <li key={host.relayId} className="kettu-sd__row">
            <DeviceTile icon={<HostIcon platform={host.platform} />} />
            <span className="ui-sg-label">
              <b className="k-name">{host.name}</b>
              <small>{platformName(host.platform)}</small>
            </span>
            <SetButton
              aria-label={t('hosts.account.connectTo', { name: host.name })}
              onClick={() => onConnect(host)}
            >
              {t('hosts.account.connect')}
            </SetButton>
          </li>
        ))}
        {others.map((computer) => (
          <li key={`${computer.state}-${computer.name}`} className="kettu-sd__row">
            <DeviceTile icon={<HostIcon platform={computer.platform} />} />
            <span className="ui-sg-label">
              <b className="k-name">{computer.name}</b>
              <small>
                {computer.state === 'remote_off'
                  ? t('hosts.account.computer.remoteOffHint')
                  : computer.lastSeenAt !== undefined
                    ? t('hosts.account.computer.lastSeen', {
                        ago: mediumAgo(computer.lastSeenAt, now),
                      })
                    : t('hosts.state.offline')}
              </small>
            </span>
            {computer.state === 'remote_off' ? (
              <Pill tone="warning">{t('hosts.account.computer.remoteOff')}</Pill>
            ) : (
              <Pill>{t('hosts.state.offline')}</Pill>
            )}
          </li>
        ))}
      </ul>
      <span className="kettu-sd__or">{t('hosts.account.or')}</span>
    </section>
  )
}

/** The pairing dialog for the host Connect was chosen for in Settings › Hosts. */
function ConnectHostDialog() {
  const host = useHostsStore((s) => s.connecting)
  const active = useRef(false)
  // The dialog itself takes focus, so no button shows a ring nor is pressed by a stray Enter.
  const popup = useRef<HTMLDivElement>(null)
  // The host stays shown while the dialog closes; each opening starts afresh.
  const [shown, setShown] = useState(host)
  const [round, setRound] = useState(0)
  if (host !== null && host !== shown) {
    setShown(host)
    setRound((n) => n + 1)
  }
  return (
    <Dialog
      open={host !== null}
      onOpenChange={(next, details) => {
        if (next || closeRequest(active.current, details.reason) === 'stay') return
        connectTo(null)
      }}
    >
      <SettingsDialogContent ref={popup} initialFocus={popup} className="sm:max-w-110">
        {Array.isArray(shown) ? (
          <AccountPairAllFlow
            key={round}
            hosts={shown}
            open={host !== null}
            activeRef={active}
            onDone={() => connectTo(null)}
          />
        ) : (
          shown && (
            <AccountPairFlow
              key={round}
              host={shown}
              open={host !== null}
              activeRef={active}
              onDone={() => connectTo(null)}
            />
          )
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

/** Why pairing with one of the account's hosts added nothing. */
type AccountPairFailure = Exclude<HostPairingFailure, `ssh_${string}`> | 'unavailable'

type AccountPairStep =
  | { kind: 'connecting' }
  | { kind: 'compare'; code: string; matched: boolean }
  | { kind: 'added'; host: HostStatus; reverse?: ReverseOutcome }
  | { kind: 'failed'; reason: AccountPairFailure }

/** Failures worth trying again at once, rather than after something changes. */
const RETRY: ReadonlySet<AccountPairFailure> = new Set([
  'void',
  'unreachable',
  'busy',
  'host_offline',
])

/** Failures the account's hosts word apart from a pasted link's. */
const OWN_TEXT: ReadonlySet<AccountPairFailure> = new Set(['void', 'rejected', 'unreachable'])

/**
 * Pairing with one of the account's hosts, inside a dialog: connecting, then the code both screens
 * show, which this computer's user says matches, then waiting for Add on the host, and how it went.
 * Leaving it ends a pairing the host has not added.
 */
export function AccountPairFlow({
  host,
  open,
  activeRef,
  onDone,
  onBack,
}: {
  host: DiscoveredHost
  open: boolean
  /** Whether a pairing is under way, so a click outside the dialog keeps it. */
  activeRef: RefObject<boolean>
  /** The dialog closes, on the host added if any. */
  onDone: (added: HostStatus | null) => void
  /** Back to where Connect was, as in Add host; the dialog closes without it. */
  onBack?: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [step, setStep] = useState<AccountPairStep>({ kind: 'connecting' })
  const offerReverse = useReverseOffered([host])
  const [reverse, setReverse] = useState(false)
  const pairing = useRef<number | null>(null)
  const attempt = useRef(0)
  // Progress of a pairing main has not named yet, as an event may beat the answer to the call.
  const early = useRef(new Map<number, HostPairingState[]>())
  const name = host.name

  const take = (state: HostPairingState): void => {
    if (state.state === 'added' || state.state === 'failed') pairing.current = null
    if (state.state === 'compare') {
      setStep({ kind: 'compare', code: state.code, matched: state.matched })
    } else if (state.state === 'added') {
      setStep({
        kind: 'added',
        host: state.host,
        ...(state.reverse ? { reverse: state.reverse } : {}),
      })
    } else if (state.state === 'failed') {
      const reason = state.reason.startsWith('ssh_') ? 'unreachable' : state.reason
      setStep({ kind: 'failed', reason: reason as AccountPairFailure })
    } else if (state.state === 'confirm') {
      setStep((now) => (now.kind === 'compare' ? { ...now, matched: true } : now))
    }
  }

  const close = (): void => {
    const pairId = pairing.current
    pairing.current = null
    if (pairId !== null) void window.kettu.hosts.closePairing(pairId)
  }

  /** The dialog closed: the pairing ends, and an answer still on its way to main is let go. */
  const abandon = (): void => {
    attempt.current++
    close()
  }

  const pair = (): void => {
    close()
    const run = ++attempt.current
    window.kettu.hosts.pairDiscovered(host.relayId, {}).then(
      (started) => {
        if (run !== attempt.current) {
          if (started.kind === 'pairing') void window.kettu.hosts.closePairing(started.pairId)
          return
        }
        if (started.kind !== 'pairing') {
          // A host no longer listed is as gone as one off the relay.
          const reason = started.kind === 'unavailable' ? 'unavailable' : 'host_offline'
          return setStep({ kind: 'failed', reason })
        }
        pairing.current = started.pairId
        const waiting = early.current.get(started.pairId) ?? []
        early.current.delete(started.pairId)
        for (const state of waiting) take(state)
      },
      () => {
        if (run === attempt.current) setStep({ kind: 'failed', reason: 'unreachable' })
      },
    )
  }

  useEffect(() => {
    if (!open) return
    const off = window.kettu.hosts.onPairing(({ pairId, pairing: state }) => {
      if (pairId === pairing.current) take(state)
      else early.current.set(pairId, [...(early.current.get(pairId) ?? []), state])
    })
    pair()
    return () => {
      off()
      abandon()
    }
    // One pairing for each opening; the handlers reach only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const active = step.kind === 'connecting' || step.kind === 'compare'
  useEffect(() => {
    activeRef.current = active
    return () => {
      activeRef.current = false
    }
  }, [active, activeRef])

  const retry = (): void => {
    setStep({ kind: 'connecting' })
    pair()
  }

  const match = (): void => {
    const pairId = pairing.current
    if (pairId === null || step.kind !== 'compare') return
    setStep({ ...step, matched: true })
    window.kettu.hosts.matchPairing(pairId, true, offerReverse && reverse).catch(() => {
      if (pairing.current === pairId) setStep({ kind: 'failed', reason: 'unreachable' })
    })
  }

  const cancel = (): void => {
    const pairId = pairing.current
    if (pairId !== null) void window.kettu.hosts.matchPairing(pairId, false).catch(() => {})
    abandon()
    if (onBack) onBack()
    else onDone(null)
  }

  if (step.kind === 'added') {
    return (
      <Added
        host={step.host}
        title={t('hosts.account.pair.title', { name })}
        note={step.reverse && <ReverseNote outcome={step.reverse} name={name} />}
        onDone={() => onDone(step.host)}
      />
    )
  }

  const failure = step.kind === 'failed' ? step.reason : null
  const code = step.kind === 'compare' ? step.code : null
  const matched = step.kind === 'compare' && step.matched
  const status =
    step.kind === 'connecting'
      ? t('hosts.account.pair.connecting', { name })
      : matched
        ? t('hosts.account.pair.waiting', { name })
        : null
  const leave = onBack ?? (() => onDone(null))
  return (
    <>
      <SettingsDialogHeader title={t('hosts.account.pair.title', { name })} />
      <SettingsDialogBody>
        {failure ? (
          <p role="alert" className="kettu-sd__error" data-selectable="">
            {failure === 'unavailable'
              ? t('hosts.keyFailed')
              : OWN_TEXT.has(failure)
                ? t(`hosts.account.failed.${failure as 'void' | 'rejected' | 'unreachable'}`, {
                    name,
                  })
                : t(`hosts.add.${failure as Exclude<AccountPairFailure, 'unavailable'>}`)}
          </p>
        ) : (
          <>
            <PairCode code={code} />
            <div className="kettu-sd__pair-text">
              {step.kind === 'connecting' ? (
                <p>{t('hosts.account.pair.intro', { name })}</p>
              ) : matched ? (
                <p>{t('hosts.account.pair.matched', { name })}</p>
              ) : (
                <>
                  <p>{t('hosts.account.pair.check', { name })}</p>
                  <p className="kettu-sd__hint">{t('hosts.account.pair.differs')}</p>
                </>
              )}
            </div>
            {offerReverse && (
              <ReverseOption
                label={t('hosts.account.reverse', { name })}
                checked={reverse}
                disabled={matched}
                onChange={setReverse}
              />
            )}
          </>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          status && (
            <span role="status" className="kettu-sd__status">
              <Spin />
              {status}
            </span>
          )
        }
      >
        {failure ? (
          <>
            <SetButton size="md" variant="ghost" onClick={leave}>
              {onBack ? t('hosts.account.back') : t('common:actions.close')}
            </SetButton>
            {RETRY.has(failure) && (
              <SetButton size="md" variant="primary" onClick={retry}>
                {t('hosts.add.retry')}
              </SetButton>
            )}
          </>
        ) : (
          <>
            <SetButton size="md" variant="ghost" onClick={cancel}>
              {t('common:actions.cancel')}
            </SetButton>
            {!matched && (
              <SetButton size="md" variant="primary" disabled={code === null} onClick={match}>
                {t('hosts.account.pair.match')}
              </SetButton>
            )}
          </>
        )}
      </SettingsDialogFooter>
    </>
  )
}

/**
 * Whether to offer letting the hosts use this computer too: only a desktop app whose own remote
 * access is on can be used, and only by hosts that are not known to be a daemon.
 */
function useReverseOffered(hosts: DiscoveredHost[]): boolean {
  const remoteOn = useSettingsStore((s) => s.settings.remote.enabled)
  return remoteOn && hosts.some((host) => host.kind !== 'daemon')
}

/** The choice to let the hosts connected to use this computer in turn. */
function ReverseOption({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2.5 self-center text-ui text-primary">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  )
}

/** Whether the host added may now use this computer too, or why not. */
function ReverseNote({ outcome, name }: { outcome: ReverseOutcome; name: string }) {
  const { t } = useTranslation('settings')
  const text =
    outcome === 'added'
      ? t('hosts.account.reverseAdded', { name })
      : outcome === 'unsupported'
        ? t('hosts.account.reverseUnsupported', { name })
        : t('hosts.account.reverseFailed', { name })
  return (
    <p
      role={outcome === 'failed' ? 'alert' : undefined}
      className={outcome === 'failed' ? 'kettu-sd__error' : 'kettu-sd__hint'}
    >
      {text}
    </p>
  )
}

/** One computer of a batch connected to under one code. */
interface BatchHost {
  host: DiscoveredHost
  pairId: number | null
  step: AccountPairStep
  transcript: PairTranscript | null
}

/**
 * Connecting to several of the account's hosts at once: every exchange starts together, under
 * one batch, and both the batch's code and each computer's own show. Codes match under the batch's
 * code confirms every computer still waiting; each computer's own button confirms only it, for
 * one asked on its own window or by a device that cannot use them all.
 */
export function AccountPairAllFlow({
  hosts,
  open,
  activeRef,
  onDone,
  onBack,
}: {
  hosts: DiscoveredHost[]
  open: boolean
  activeRef: RefObject<boolean>
  onDone: (added: HostStatus | null) => void
  onBack?: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [batch, setBatch] = useState<BatchHost[]>(() =>
    hosts.map((host) => ({ host, pairId: null, step: { kind: 'connecting' }, transcript: null })),
  )
  const [group] = useState(() => newPairGroup(hosts.map((host) => host.relayId)))
  const offerReverse = useReverseOffered(hosts)
  const [reverse, setReverse] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const early = useRef(new Map<number, HostPairingState[]>())
  const pairIds = useRef(new Map<number, string>())

  const update = (relayId: string, state: HostPairingState): void =>
    setBatch((now) =>
      now.map((entry) => {
        if (entry.host.relayId !== relayId) return entry
        if (state.state === 'compare') {
          return {
            ...entry,
            step: { kind: 'compare', code: state.code, matched: state.matched },
            transcript: state.transcript ?? entry.transcript,
          }
        }
        if (state.state === 'added') {
          const added: AccountPairStep = {
            kind: 'added',
            host: state.host,
            ...(state.reverse ? { reverse: state.reverse } : {}),
          }
          return { ...entry, pairId: null, step: added }
        }
        if (state.state === 'failed') {
          const reason = state.reason.startsWith('ssh_') ? 'unreachable' : state.reason
          return {
            ...entry,
            pairId: null,
            step: { kind: 'failed', reason: reason as AccountPairFailure },
          }
        }
        if (state.state === 'confirm' && entry.step.kind === 'compare') {
          return { ...entry, step: { ...entry.step, matched: true } }
        }
        return entry
      }),
    )

  useEffect(() => {
    if (!open) return
    let live = true
    const started = pairIds.current
    const off = window.kettu.hosts.onPairing(({ pairId, pairing: state }) => {
      const relayId = started.get(pairId)
      if (relayId) update(relayId, state)
      else early.current.set(pairId, [...(early.current.get(pairId) ?? []), state])
    })
    for (const { relayId } of hosts) {
      window.kettu.hosts.pairDiscovered(relayId, { group }).then(
        (begun) => {
          if (begun.kind !== 'pairing') {
            const reason = begun.kind === 'unavailable' ? 'unavailable' : 'host_offline'
            return update(relayId, { state: 'failed', reason: reason as HostPairingFailure })
          }
          if (!live) return void window.kettu.hosts.closePairing(begun.pairId)
          started.set(begun.pairId, relayId)
          setBatch((now) =>
            now.map((entry) =>
              entry.host.relayId === relayId ? { ...entry, pairId: begun.pairId } : entry,
            ),
          )
          const waiting = early.current.get(begun.pairId) ?? []
          early.current.delete(begun.pairId)
          for (const state of waiting) update(relayId, state)
        },
        () => update(relayId, { state: 'failed', reason: 'unreachable' }),
      )
    }
    return () => {
      live = false
      off()
      for (const pairId of started.keys()) void window.kettu.hosts.closePairing(pairId)
      started.clear()
    }
    // One batch for each opening; the handlers reach only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The batch's code once every computer's exchange is known; a computer that failed voids it.
  const transcripts = batch.every(
    (entry) => entry.transcript !== null && entry.step.kind !== 'failed',
  )
    ? new Map(batch.map((entry) => [entry.host.relayId, entry.transcript!]))
    : null
  const transcriptKey = transcripts ? JSON.stringify([...transcripts]) : ''
  useEffect(() => {
    if (!transcripts) return
    let live = true
    void groupCodeOf(group.hosts, transcripts).then((worked) => {
      if (live) setCode(worked)
    })
    return () => {
      live = false
    }
    // The transcripts are read again only when one of them changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptKey, group])
  const shownCode = transcripts ? code : null

  const waiting = batch.filter((entry) => entry.step.kind === 'compare' && !entry.step.matched)
  const active = batch.some(
    (entry) => entry.step.kind === 'connecting' || entry.step.kind === 'compare',
  )
  useEffect(() => {
    activeRef.current = active
    return () => {
      activeRef.current = false
    }
  }, [active, activeRef])

  const matchOne = (entry: BatchHost): void => {
    const { pairId, step } = entry
    if (pairId === null || step.kind !== 'compare' || step.matched) return
    update(entry.host.relayId, { state: 'compare', code: step.code, matched: true })
    // A daemon has no client to keep this computer with, so it is not asked.
    const asked = offerReverse && reverse && entry.host.kind !== 'daemon'
    window.kettu.hosts.matchPairing(pairId, true, asked).catch(() => {
      update(entry.host.relayId, { state: 'failed', reason: 'unreachable' })
    })
  }
  const matchAll = (): void => {
    for (const entry of waiting) matchOne(entry)
  }
  const cancel = (): void => {
    for (const entry of batch) {
      if (entry.pairId !== null) void window.kettu.hosts.matchPairing(entry.pairId, false, false)
    }
    if (onBack) onBack()
    else onDone(null)
  }

  const added = batch.filter((entry) => entry.step.kind === 'added').length
  const matchedAny = batch.some(
    (entry) => entry.step.kind === 'added' || (entry.step.kind === 'compare' && entry.step.matched),
  )
  const status = batch.some((entry) => entry.step.kind === 'connecting')
    ? t('hosts.account.pair.connecting')
    : null
  return (
    <>
      <SettingsDialogHeader
        title={
          active
            ? t('hosts.account.pairAll.title', { count: hosts.length })
            : added === hosts.length
              ? t('hosts.account.pairAll.added', { count: added })
              : added === 0
                ? t('hosts.account.pairAll.none')
                : t('hosts.account.pairAll.partial', { added, count: hosts.length })
        }
      />
      <SettingsDialogBody>
        {active && (
          <>
            <PairCode code={shownCode} />
            <div className="kettu-sd__pair-text">
              <p>
                {shownCode === null
                  ? t('hosts.account.pairAll.intro')
                  : waiting.length === 0
                    ? t('hosts.account.pairAll.matched')
                    : t('hosts.account.pairAll.check')}
              </p>
            </div>
          </>
        )}
        <section aria-labelledby={active ? 'pair-all-each' : undefined} className="kettu-sd__field">
          {active && (
            <h3 id="pair-all-each" className="kettu-sd__label">
              {t('hosts.account.pairAll.each')}
            </h3>
          )}
          <ul className="kettu-sd__list kettu-sd__account">
            {batch.map((entry) => (
              <BatchRow key={entry.host.relayId} entry={entry} onMatch={() => matchOne(entry)} />
            ))}
          </ul>
        </section>
        {offerReverse && active && (
          <ReverseOption
            label={t('hosts.account.reverse', {
              name: new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
                hosts.filter((host) => host.kind !== 'daemon').map((host) => host.name),
              ),
            })}
            checked={reverse}
            disabled={matchedAny}
            onChange={setReverse}
          />
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          status && (
            <span role="status" className="kettu-sd__status">
              <Spin />
              {status}
            </span>
          )
        }
      >
        {active ? (
          <>
            <SetButton size="md" variant="ghost" onClick={cancel}>
              {t('common:actions.cancel')}
            </SetButton>
            {waiting.length > 0 && (
              <SetButton
                size="md"
                variant="primary"
                disabled={shownCode === null}
                onClick={matchAll}
              >
                {t('hosts.account.pair.match')}
              </SetButton>
            )}
          </>
        ) : (
          <SetButton size="md" variant="primary" onClick={() => onDone(null)}>
            {t('hosts.add.done')}
          </SetButton>
        )}
      </SettingsDialogFooter>
    </>
  )
}

/** One computer of a batch: its own code with its own Codes match, or how it went. */
function BatchRow({ entry, onMatch }: { entry: BatchHost; onMatch: () => void }) {
  const { t } = useTranslation('settings')
  const { host, step } = entry
  const line =
    step.kind === 'compare'
      ? `${step.code.slice(0, 3)} ${step.code.slice(3)}`
      : step.kind === 'added'
        ? step.reverse && reverseLine(t, step.reverse, host.name)
        : step.kind === 'failed'
          ? t(
              `hosts.account.pairAll.failed.${OWN_TEXT.has(step.reason) ? (step.reason as 'void') : 'other'}`,
            )
          : t('hosts.account.pairAll.state.connecting')
  return (
    <li className="kettu-sd__row">
      <DeviceTile icon={<HostIcon platform={host.platform} />} />
      <span className="ui-sg-label">
        <b className="k-name">{host.name}</b>
        {line && (
          <small className={step.kind === 'compare' ? 'kettu-sd__each-code' : undefined}>
            {line}
          </small>
        )}
      </span>
      {step.kind === 'compare' && !step.matched ? (
        <SetButton
          aria-label={t('hosts.account.pair.title', { name: host.name })}
          onClick={onMatch}
        >
          {t('hosts.account.pair.match')}
        </SetButton>
      ) : step.kind === 'compare' ? (
        <Pill>{t('hosts.account.pairAll.state.matched')}</Pill>
      ) : step.kind === 'added' ? (
        <Pill tone="success">{t('hosts.account.pairAll.state.added')}</Pill>
      ) : step.kind === 'failed' ? (
        <Pill tone="warning">{t('hosts.account.pairAll.state.failed')}</Pill>
      ) : (
        <Spin />
      )}
    </li>
  )
}

function reverseLine(
  t: ReturnType<typeof useTranslation<'settings'>>['t'],
  outcome: ReverseOutcome,
  name: string,
): string {
  if (outcome === 'added') return t('hosts.account.reverseAdded', { name })
  if (outcome === 'unsupported') return t('hosts.account.reverseUnsupported', { name })
  return t('hosts.account.reverseFailed', { name })
}

/** The six-digit code both screens show, in two groups of three; a spinner until it is known. */
export function PairCode({ code }: { code: string | null }) {
  const { t } = useTranslation('settings')
  if (code === null) {
    return (
      <div className="kettu-sd__code" data-pending="">
        <Spin />
      </div>
    )
  }
  return (
    <div
      role="img"
      aria-label={t('hosts.account.codeLabel', { code: [...code].join(' ') })}
      className="kettu-sd__code"
    >
      <span aria-hidden>{code.slice(0, 3)}</span>
      <span aria-hidden>{code.slice(3)}</span>
    </div>
  )
}
