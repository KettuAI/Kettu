// The hosts the hosted web client paired with, kept for each Kettu account apart, so another account
// signed in on the same browser never lists them; and how it reaches one, through the relays it
// signs in to. The account's access token goes only to the project's relays.

import type { RelayProblem } from '@shared/remote/hosts'
import { trustedRelay, type HostRelay } from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import type { Dial } from '@shared/remote/link'
import { HOSTED_STORE, run } from '../storage'
import { relayUrl } from './config'

export interface HostedHost {
  /** The host's X25519 public key, which every handshake is encrypted to. */
  hostKey: Uint8Array
  relay: HostRelay
  /** The host's name and this browser's name there, as the last welcome said. */
  name: string
  deviceName: string
}

export interface AccountHosts {
  hosts: HostedHost[]
  /** The relay id of the host the page shows, the last one chosen. */
  current: string | null
}

/** How long the relays have to join a host. */
const RELAY_TIMEOUT_MS = 15_000

const recordOf = (accountId: string): string => `hosts:${accountId}`

function isHostedHost(value: unknown): value is HostedHost {
  const host = value as Partial<HostedHost> | null
  return (
    host?.hostKey instanceof Uint8Array &&
    typeof host.relay?.id === 'string' &&
    Array.isArray(host.relay.urls) &&
    typeof host.name === 'string' &&
    typeof host.deviceName === 'string'
  )
}

export async function loadHosts(accountId: string): Promise<AccountHosts> {
  const value = (await run('readonly', (store) => store.get(recordOf(accountId)), HOSTED_STORE)) as
    Partial<AccountHosts> | undefined
  const hosts = Array.isArray(value?.hosts) ? value.hosts.filter(isHostedHost) : []
  const current = typeof value?.current === 'string' ? value.current : null
  return { hosts, current: hosts.some((h) => h.relay.id === current) ? current : null }
}

export async function saveHosts(accountId: string, hosts: AccountHosts): Promise<void> {
  await run('readwrite', (store) => store.put(hosts, recordOf(accountId)), HOSTED_STORE)
}

/** The hosts with `host` added, or put in place of the one with its relay id; shown from now on. */
export function withHost(hosts: AccountHosts, host: HostedHost): AccountHosts {
  const others = hosts.hosts.filter((h) => h.relay.id !== host.relay.id)
  return { hosts: [...others, host], current: host.relay.id }
}

/** The host the page shows: the one chosen last, else the first. */
export function currentHost(hosts: AccountHosts): HostedHost | null {
  return hosts.hosts.find((h) => h.relay.id === hosts.current) ?? hosts.hosts[0] ?? null
}

/** Why the relay did not join a host, which the dial rejects with. */
export class RelayMiss extends Error {
  constructor(readonly problem: RelayProblem) {
    super(`The relay did not reach the host: ${problem}`)
    this.name = 'RelayMiss'
  }
}

/**
 * Dials the host through its relays, the project's main one included, with the account's token;
 * `missed` hears why a try did not join.
 */
export function relayDial(
  relay: HostRelay,
  token: () => Promise<string | null>,
  missed: (problem: RelayProblem | null) => void,
): Dial {
  const relays = [...new Set([...relay.urls, relayUrl])].filter((url) =>
    trustedRelay(url, relayUrl),
  )
  return async () => {
    const access = await token()
    if (!access) {
      missed('signed_out')
      throw new RelayMiss('signed_out')
    }
    const result = await dialRelay({
      relays,
      id: relay.id,
      token: access,
      openSocket: (url) => new WebSocket(url),
      timeoutMs: RELAY_TIMEOUT_MS,
    })
    if (result.kind === 'joined') {
      missed(null)
      return webSocketTransport(result.socket, true)
    }
    const problem: RelayProblem =
      result.kind === 'offline'
        ? 'host_offline'
        : result.kind === 'forbidden'
          ? 'wrong_account'
          : 'unreachable'
    missed(problem)
    throw new RelayMiss(problem)
  }
}
