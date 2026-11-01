import type { TFunction } from 'i18next'
import type { Platform } from '@shared/platform'
import { addressText } from '@shared/remote/address'
import type { HostChangeFailure, HostStatus } from '@shared/remote/hosts'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
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

/**
 * How a host is reached: over SSH at the address the user typed, or direct, with the address that
 * answered while it is online.
 */
export function routeText(
  t: TFunction<'settings'>,
  host: Pick<HostStatus, 'connection' | 'ssh'>,
): string {
  if (host.ssh) return t('hosts.via.sshAt', { target: host.ssh.target })
  return host.connection.state === 'online'
    ? t('hosts.via.directAt', { address: addressText(host.connection.address) })
    : t('hosts.via.direct')
}

/** The route alone, as the sidebar names it beside a host online. */
export function routeName(t: TFunction<'settings'>, host: Pick<HostStatus, 'ssh'>): string {
  return host.ssh ? t('hosts.via.ssh') : t('hosts.via.direct')
}

/** The line under a host's name: its system, Kettu's version and how it is reached. */
export function hostLine(t: TFunction<'settings'>, host: HostStatus): string {
  return [
    platformName(host.platform),
    t('hosts.version', { version: host.version }),
    routeText(t, host),
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
    t('hosts.via.directAt', { address: addressText(host.address) }),
  ]
    .filter((part): part is string => !!part)
    .join(' · ')
}
