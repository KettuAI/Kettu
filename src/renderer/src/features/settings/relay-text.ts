// What Settings › Remote access says of the Kettu relay, from the host's report.

import { useTranslation } from 'react-i18next'
import type { RelayStatus } from '@shared/remote/relay-host'
import { relaySummary, type RemoteStatus } from '@shared/remote/status'
import { useHostContext } from '@renderer/lib/host-features'

/** Whether devices reach the host through the relay now: on, and signed in. */
export function relayInUse(status: RemoteStatus | null): boolean {
  return status?.relay?.state === 'on'
}

/** What the status line says of the relay, or null when it adds nothing. */
export function useRelayLine(status: RemoteStatus | null): {
  part: string | null
  problem: { text: string; hint: string; conflict: boolean } | null
  connecting: boolean
  signInHint: string | null
} {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const summary = relaySummary(status?.relay)
  const failed = summary === 'failed' || summary === 'conflict'
  const error = failed && status?.relay?.state === 'on' ? firstError(status.relay.relays) : null
  return {
    part: summary === 'connected' ? t('remote.status.relay') : null,
    problem: failed
      ? {
          text: t(summary === 'conflict' ? 'remote.relay.conflict' : 'remote.relay.failed'),
          hint:
            summary === 'conflict'
              ? t('remote.relay.conflictHint', onHost)
              : t(`remote.relay.errorHint.${errorGroup(error)}`),
          conflict: summary === 'conflict',
        }
      : null,
    connecting: summary === 'connecting',
    signInHint: summary === 'signed_out' ? t('remote.relay.signInHint', onHost) : null,
  }
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
