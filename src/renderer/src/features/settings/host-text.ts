import type { TFunction } from 'i18next'
import type { Platform } from '@shared/platform'
import { addressText } from '@shared/remote/address'
import type { HostConnection, HostStatus } from '@shared/remote/hosts'
import { longAgo } from '@renderer/lib/format'
import type { WebHost } from '@renderer/stores/web-host'

/** "iOS", "macOS", "Windows": what a host or device runs, by the platform it sent. */
export function platformName(platform: Platform | string): string {
  if (platform === 'ios') return 'iOS'
  if (platform === 'ipados') return 'iPadOS'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** How a host is reached: direct, with the address that answered while it is online. */
export function routeText(t: TFunction<'settings'>, connection: HostConnection): string {
  return connection.state === 'online'
    ? t('hosts.via.directAt', { address: addressText(connection.address) })
    : t('hosts.via.direct')
}

/** The line under a host's name: its system, Kettu's version and how it is reached. */
export function hostLine(t: TFunction<'settings'>, host: HostStatus): string {
  return [
    platformName(host.platform),
    t('hosts.version', { version: host.version }),
    routeText(t, host.connection),
  ].join(' · ')
}

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
      return host.lastOnlineAt === null
        ? t('hosts.state.offline')
        : t('hosts.state.offlineSince', { ago: longAgo(host.lastOnlineAt, now) })
    case 'stopped':
      return t(`hosts.state.${connection.reason}`)
  }
}

/** The line under the host's name: its system, Kettu's version, and the page's address. */
export function webHostLine(t: TFunction<'settings'>, host: WebHost): string {
  return [
    host.platform && platformName(host.platform),
    host.version && t('hosts.version', { version: host.version }),
    t('hosts.via.directAt', { address: addressText(host.address) }),
  ]
    .filter((part): part is string => !!part)
    .join(' · ')
}
