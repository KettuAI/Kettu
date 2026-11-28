// What Settings › Remote access says of the Kettu relay, from the host's report.

import { useTranslation } from 'react-i18next'
import type { RelayStatus } from '@shared/remote/relay-host'
import { relaySummary, type RemoteStatus } from '@shared/remote/status'
import { useHostContext } from '@renderer/lib/host-features'
import { useCloudOffHere } from './use-cloud-off-here'

/** Whether devices may reach the host through at least one relay (official or own). */
export function relayInUse(status: RemoteStatus | null): boolean {
  return status?.relay?.state === 'on' || Boolean(status?.relay?.own)
}

/**
 * What the status line says of the relay, or null when it adds nothing, as on this computer while
 * Kettu's cloud is off and no own relay is active.
 */
export function useRelayLine(status: RemoteStatus | null): {
  part: string | null
  problem: { text: string; hint: string; conflict: boolean } | null
  /** What the line says while the relay is still connecting, null when it is not. */
  connecting: string | null
  signInHint: string | null
} {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const cloudOff = useCloudOffHere()
  const relay = status?.relay
  const own = relay?.own ?? null
  const host = own ? relayHostName(own.url) : ''
  const officialRelay = cloudOff ? undefined : relay
  const officialStates =
    officialRelay?.state === 'on' ? officialRelay.relays.map((r) => r.connection) : []
  const ownConn = own?.connection ?? null

  const officialConnected = officialStates.some((c) => c.state === 'connected')
  const ownConnected = ownConn?.state === 'connected'

  const officialError = officialRelay?.state === 'on' ? firstError(officialRelay.relays) : null
  const ownError =
    ownConn && (ownConn.state === 'retrying' || ownConn.state === 'refused') ? ownConn.error : null

  const conflict =
    officialStates.some((c) => c.state === 'conflict') || ownConn?.state === 'conflict'
  const anyConnected = officialConnected || ownConnected
  const anyConnecting =
    !anyConnected &&
    (officialStates.some((c) => c.state === 'connecting') ||
      ownConn?.state === 'connecting' ||
      (own !== null && ownConn === null && own.rtt === null))
  const failed = !anyConnected && (conflict || officialError !== null || ownError !== null)
  const problemIsOwnOnly =
    own !== null && !officialError && (ownError !== null || ownConn?.state === 'conflict')
  const error = ownError ?? officialError
  const group = errorGroup(error)

  const summary = cloudOff && !own ? null : relaySummary(relay)
  const part =
    officialConnected && ownConnected
      ? t('remote.status.relaysBoth', { host })
      : ownConnected
        ? t('remote.status.ownRelay', { host })
        : officialConnected
          ? t('remote.status.relay')
          : null

  return {
    part,
    problem: failed
      ? {
          text: conflict
            ? t('remote.relay.conflict')
            : problemIsOwnOnly
              ? t('remote.relay.own.lineFailed', { host })
              : t('remote.relay.failed'),
          hint: conflict
            ? t('remote.relay.conflictHint', onHost)
            : problemIsOwnOnly && group === 'refused'
              ? t('remote.relay.own.refusedHint')
              : t(`remote.relay.errorHint.${group}`),
          conflict,
        }
      : null,
    connecting: !anyConnecting
      ? null
      : own && officialStates.length === 0
        ? t('remote.relay.own.connecting', { host })
        : t('remote.relay.connecting'),
    signInHint:
      !cloudOff && officialRelay?.state === 'signed_out' && summary !== 'connected'
        ? t('remote.relay.signInHint', onHost)
        : null,
  }
}

/** A relay's host and port as the page names it, without the scheme. */
export function relayHostName(url: string): string {
  return URL.parse(url)?.host ?? url
}

function firstError(relays: RelayStatus[]): string | null {
  for (const { connection } of relays) {
    if (connection.state === 'retrying' || connection.state === 'refused') return connection.error
  }
  return null
}

/** The few kinds of failure the hint tells apart. */
export function errorGroup(error: string | null): 'refused' | 'busy' | 'unreachable' {
  if (error === 'unauthorized' || error === 'forbidden') return 'refused'
  if (error === 'too_many') return 'busy'
  return 'unreachable'
}
