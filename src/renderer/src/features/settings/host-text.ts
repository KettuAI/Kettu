import type { TFunction } from 'i18next'
import type { Platform } from '@shared/platform'
import { addressText, isLocalHost } from '@shared/remote/address'
import type { HostChangeFailure, HostStatus } from '@shared/remote/hosts'
import type { DirectAddress } from '@shared/remote/protocol'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { isRelayPage, isWeb } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import type { WebHost } from '@renderer/stores/web-host'
import { relayHostName } from './relay-text'

/** "iOS", "macOS", "Windows": what a host or device runs, by the platform it sent. */
export function platformName(platform: Platform | string): string {
  if (platform === 'ios') return 'iOS'
  if (platform === 'ipados') return 'iPadOS'
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

/**
 * How a host is reached: over SSH at the address the user typed, through the relay with its
 * region, or direct, with the address that answered while it is online.
 */
export function routeText(
  t: TFunction<'settings'>,
  host: Pick<HostStatus, 'connection' | 'ssh'>,
): string {
  if (host.ssh) return t('hosts.via.sshAt', { target: host.ssh.target })
  const { connection } = host
  if (connection.state !== 'online') return t('hosts.via.direct')
  if (!('relay' in connection)) return directAt(t, connection.address)
  if (connection.own) return t('hosts.via.ownRelayAt', { host: relayHostName(connection.relay) })
  return connection.region
    ? t('hosts.via.relayAt', { region: connection.region })
    : t('hosts.via.relay')
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
