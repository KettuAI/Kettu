// What Settings › Remote access says of the Kettu relay, from the host's report.

import { useTranslation } from 'react-i18next'
import type { RelayStatus } from '@shared/remote/relay-host'
import { relaySummary, type RemoteStatus } from '@shared/remote/status'
import { useHostContext } from '@renderer/lib/host-features'
import { useCloudOffHere } from './use-cloud-off-here'

/** Whether devices reach the host through the relay now: on, and signed in. */
export function relayInUse(status: RemoteStatus | null): boolean {
  return status?.relay?.state === 'on'
}

/**
 * What the status line says of the relay, or null when it adds nothing, as on this computer while
 * Kettu's cloud is off.
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
  const own = status?.relay?.state === 'on' ? (status.relay.own ?? null) : null
  // The owner's own relay is no service of Kettu's, so it shows in Local mode too.
  const summary = cloudOff && !own ? null : relaySummary(status?.relay)
  const failed = summary === 'failed' || summary === 'conflict'
  const error = failed && status?.relay?.state === 'on' ? firstError(status.relay.relays) : null
  const host = own ? relayHostName(own.url) : ''
  const group = errorGroup(error)
  return {
    part:
      summary === 'connected'
        ? own
          ? t('remote.status.ownRelay', { host })
          : t('remote.status.relay')
        : null,
    problem: failed
      ? {
          text:
            summary === 'conflict'
              ? t('remote.relay.conflict')
              : own
                ? t('remote.relay.own.lineFailed', { host })
                : t('remote.relay.failed'),
          hint:
            summary === 'conflict'
              ? t('remote.relay.conflictHint', onHost)
              : own && group === 'refused'
                ? t('remote.relay.own.refusedHint')
                : t(`remote.relay.errorHint.${group}`),
          conflict: summary === 'conflict',
        }
      : null,
    connecting:
      summary !== 'connecting'
        ? null
        : own
          ? t('remote.relay.own.connecting', { host })
          : t('remote.relay.connecting'),
    signInHint: summary === 'signed_out' ? t('remote.relay.signInHint', onHost) : null,
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
