// Pairing this browser with the host that served it, with the code from a link: the IKpsk1
// handshake with the code's secret, then the owner's answer on the host. A pairing the owner
// accepts leaves its connection open, for the link to take as its first.

import { HandshakeDropped } from '@shared/remote/device-channel'
import type { KeyPair } from '@shared/remote/noise'
import type { PairingPayload } from '@shared/remote/pairing'
import type { Hello, Welcome } from '@shared/remote/protocol'
import { awaitWelcome, hello, openChannel, type Dial, type Later, type Opened } from './link'

export type PairFailure = 'void' | 'rejected' | 'unreachable' | 'update_client' | 'update_host'

export type PairProgress =
  | { state: 'connecting' }
  /** The secret checked out; the owner is asked on the host. */
  | { state: 'waiting' }
  | { state: 'failed'; reason: PairFailure }

export interface Paired {
  opened: Opened
  welcome: Welcome
  later: Later[]
}

export interface PairOptions {
  dial: Dial
  payload: PairingPayload
  key: KeyPair
  client: Hello['client']
  device: NonNullable<Hello['device']>
}

/** Pairs, telling `progress` how it goes; resolves with the welcomed connection, or null. */
export async function pair(
  options: PairOptions,
  progress: (state: PairProgress) => void,
): Promise<Paired | null> {
  progress({ state: 'connecting' })
  let opened: Opened
  try {
    opened = await openChannel(options.dial, {
      hostKey: options.payload.hostKey,
      key: options.key,
      psk: options.payload.secret,
      hello: hello(options.client, options.device),
    })
  } catch (error) {
    // The host drops a handshake whose code it does not hold: expired, used, or another host's.
    progress({
      state: 'failed',
      reason: error instanceof HandshakeDropped ? 'void' : 'unreachable',
    })
    return null
  }
  progress({ state: 'waiting' })
  const answer = await awaitWelcome(opened, null)
  if ('welcome' in answer) return { opened, welcome: answer.welcome, later: answer.later }
  const reason = answer.closing
  progress({
    state: 'failed',
    reason:
      reason === 'rejected' || reason === 'update_client' || reason === 'update_host'
        ? reason
        : 'void',
  })
  return null
}
