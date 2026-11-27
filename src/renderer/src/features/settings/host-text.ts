import type { TFunction } from 'i18next'
import type { Platform } from '@shared/platform'
import { addressText, isLocalHost } from '@shared/remote/address'
import type { HostChangeFailure, HostStatus } from '@shared/remote/hosts'
import type { DirectAddress } from '@shared/remote/protocol'
import { isOwnRelay, RELAY_URL } from '@shared/remote/relay'
import { localizedRegionName } from '@shared/remote/relay-regions'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { isRelayPage, isWeb } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import type { WebHost } from '@renderer/stores/web-host'
import { relayHostName } from './relay-text'

/** "iOS", "Android", "macOS", "Windows": what a host or device runs, by the platform it sent. */
export function platformName(platform: Platform | string): string {
  if (platform === 'ios') return 'iOS'
  if (platform === 'ipados') return 'iPadOS'
  if (platform === 'android') return 'Android'
  if (/^android\s+/i.test(platform)) return platform.replace(/^android/i, 'Android')
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** A direct address as its path: the same network for a private one, direct for the rest. */
function directAt(t: TFunction<'settings'>, address: DirectAddress): string {
  const text = addressText(address)
  return isLocalHost(address.host)
    ? t('hosts.via.lanAt', { address: text })
    : t('hosts.via.directAt', { address: text })
}

export type ConfiguredRelay = { kind: 'kettu' } | { kind: 'own'; host: string } | { kind: 'none' }

/**
 * The relay configured for a non-SSH host, whether it is online or offline: the Kettu relay,
 * the hostname of the owner's own relay, or none (direct only).
 */
export function configuredRelay(host: Pick<HostStatus, 'relay' | 'connection'>): ConfiguredRelay {
  const { connection, relay } = host
  if (connection.state === 'online' && 'relay' in connection) {
    return connection.own
      ? { kind: 'own', host: relayHostName(connection.relay) }
      : { kind: 'kettu' }
  }
  if (!relay || relay.urls.length === 0) return { kind: 'none' }
  return isOwnRelay(relay, RELAY_URL)
    ? { kind: 'own', host: relayHostName(relay.urls[0]!) }
    : { kind: 'kettu' }
}

/**
 * How a host is reached: over SSH at the address the user typed, through the relay with its
 * region, or direct, with the address that answered while it is online. When offline, reflects
 * the host's configured relay instead of assuming direct only.
 */
export function routeText(
  t: TFunction<'settings'>,
  host: Pick<HostStatus, 'connection' | 'ssh' | 'relay'>,
): string {
  if (host.ssh) return t('hosts.via.sshAt', { target: host.ssh.target })
  const { connection } = host
  if (connection.state !== 'online') {
    const configured = configuredRelay(host)
    if (configured.kind === 'own') return t('hosts.via.ownRelayAt', { host: configured.host })
    if (configured.kind === 'kettu') return t('hosts.via.relay')
    return t('hosts.via.noRelay')
  }
  if (!('relay' in connection)) return directAt(t, connection.address)
  if (connection.own) return t('hosts.via.ownRelayAt', { host: relayHostName(connection.relay) })
  const region = localizedRegionName(connection.region, connection.regionNames, currentLocale())
  return region ? t('hosts.via.relayAt', { region }) : t('hosts.via.relay')
}

/** The route alone, as the sidebar names it beside a host online. */
export function routeName(
  t: TFunction<'settings'>,
  host: Pick<HostStatus, 'ssh' | 'connection'>,
): string {
  if (host.ssh) return t('hosts.via.ssh')
  const { connection } = host
  if (connection.state !== 'online') return t('hosts.via.direct')
  if ('relay' in connection) return t(connection.own ? 'hosts.via.ownRelay' : 'hosts.via.relay')
  return isLocalHost(connection.address.host) ? t('hosts.via.lan') : t('hosts.via.direct')
}

/** The line under a host's name: its system, Kettu's version and how it is reached. */
export function hostLine(t: TFunction<'settings'>, host: HostStatus): string {
  return [
    platformName(host.platform),
    t('hosts.version', { version: host.version }),
    routeText(t, host),
  ].join(' · ')
}

// Read when the text is made; the switch changes rarely and Settings redraws when it does.
const cloudOff = (): boolean => !isWeb && !useSettingsStore.getState().settings.cloud.enabled

/** Whether a host is online, and when it last was while it is not. */
export function connectionText(
  t: TFunction<'settings'>,
  host: Pick<HostStatus, 'connection' | 'lastOnlineAt'>,
  now = Date.now(),
): string {
  const { connection } = host
  switch (connection.state) {
    case 'online':
      return t('hosts.state.online')
    case 'connecting':
      return t('hosts.state.connecting')
    case 'offline':
      // Every relay saying the host is not signed in is as offline as no answer at all, and so
      // is any relay reason while this computer keeps off Kettu's cloud.
      if (connection.relay && connection.relay !== 'host_offline' && !cloudOff()) {
        return t(`hosts.state.relay.${connection.relay}`)
      }
      return host.lastOnlineAt === null
        ? t('hosts.state.offline')
        : t('hosts.state.offlineSince', { ago: mediumAgo(host.lastOnlineAt, now) })
    case 'stopped':
      return t(`hosts.state.${connection.reason}`)
  }
}

/** Changes a host through main: null once done, else what to show for it. */
export async function changeHost(
  t: TFunction<'settings'>,
  host: Pick<HostStatus, 'name'>,
  change: () => Promise<HostChangeFailure | null>,
): Promise<string | null> {
  try {
    const failure = await change()
    return failure === null ? null : t(`hosts.failed.${failure}`, { name: host.name })
  } catch (error) {
    return errorMessage(error)
  }
}

/** The line under the host's name: its system, Kettu's version, and the page's address. */
export function webHostLine(t: TFunction<'settings'>, host: WebHost): string {
  return [
    host.platform && platformName(host.platform),
    host.version && t('hosts.version', { version: host.version }),
    host.address
      ? directAt(t, host.address)
      : t(isRelayPage ? 'hosts.via.ownRelay' : 'hosts.via.relay'),
  ]
    .filter((part): part is string => !!part)
    .join(' · ')
}
