// Pairing with the account's other computers: the list in Settings › Hosts and Add host, and the
// dialog that compares the code both screens show.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { ComputerIcon, RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { DiscoveredHost, DiscoveredHosts } from '@shared/remote/discovery'
import type { HostPairingFailure, HostPairingState, HostStatus } from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { Dialog } from '@renderer/components/ui/dialog'
import { signIn } from '@renderer/stores/account'
import { connectTo, loadDiscovered, useHostsStore } from '@renderer/stores/hosts'
import { IconAction, SetButton, Skel, Spin } from './controls'
import { Added } from './host-added'
import { platformName } from './host-text'
import { closeRequest } from './pair-close'
import { DeviceTile, HostIcon } from './remote-parts'
import { useDiscoveredHosts, useRereadDiscovered } from './use-discovered'
import { ItemLine, RowLine, RowText, Thing } from './rows'
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
  return (
    <div className="ui-as-empty" data-bare="">
      <span className="ui-as-empty__icon">
        <Icon icon={ComputerIcon} size={18} />
      </span>
      <b className="ui-as-empty__title">{t('hosts.account.empty.title')}</b>
      <p className="ui-as-empty__text">{t('hosts.account.empty.body')}</p>
    </div>
  )
}

/** The account group's heading actions: list again, and the pairing dialog Connect opens. */
export function AccountHostsActions({ signedOut }: { signedOut: boolean }) {
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  // Drawn only while Settings shows the list.
  useRereadDiscovered()
  return (
    <>
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
export function AccountHostsPicker({ onConnect }: { onConnect: (host: DiscoveredHost) => void }) {
  const { t } = useTranslation('settings')
  const discovered = useDiscoveredHosts()
  useRereadDiscovered()
  if (discovered?.state !== 'ok' || discovered.hosts.length === 0) return null
  return (
    <section aria-labelledby="account-hosts-label" className="kettu-sd__field">
      <h3 id="account-hosts-label" className="kettu-sd__label">
        {t('hosts.account.group')}
      </h3>
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
        {shown && (
          <AccountPairFlow
            key={round}
            host={shown}
            open={host !== null}
            activeRef={active}
            onDone={() => connectTo(null)}
          />
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
  | { kind: 'added'; host: HostStatus }
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
      setStep({ kind: 'added', host: state.host })
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
    window.kettu.hosts.pairDiscovered(host.relayId).then(
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
    window.kettu.hosts.matchPairing(pairId, true).catch(() => {
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
