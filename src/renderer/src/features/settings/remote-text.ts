import type { TFunction } from 'i18next'
import {
  DEVICE_NAME_CHARS,
  type DeviceChangeFailure,
  type PairedDevice,
} from '@shared/remote/device'
import { removalAt, UNSEEN_NOTICE_DAYS } from '@shared/remote/status'
import type { SystemLogoName } from '@renderer/components/system-logo'
import { clockTime, daysBefore, monthDay } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { platformName } from './host-text'

const DAY = 24 * 60 * 60 * 1000

type Device = Pick<PairedDevice, 'kind' | 'model' | 'platform'>

/** "iOS app", "Desktop app": what a device runs Kettu in. */
export function kindLabel(t: TFunction<'settings'>, kind: string): string {
  if (kind === 'ios' || kind === 'desktop' || kind === 'web') return t(`remote.kinds.${kind}`)
  return kind
}

/** The line under a device's name: what it runs Kettu in, its model and its system. */
export function deviceLine(t: TFunction<'settings'>, device: Device): string {
  return [kindLabel(t, device.kind), device.model, platformName(device.platform)]
    .filter(Boolean)
    .join(' · ')
}

/** A trimmed rename that fits, or null when the draft is empty, unchanged or too long. */
export function nextDeviceName(current: string, draft: string): string | null {
  const next = draft.trim()
  if (next === '' || next === current || [...next].length > DEVICE_NAME_CHARS) return null
  return next
}

/** Renames or removes a device through main: null once done, else what to show for it. */
export async function changeDevice(
  t: TFunction<'settings'>,
  change: () => Promise<DeviceChangeFailure | null>,
): Promise<string | null> {
  try {
    const failure = await change()
    return failure === null ? null : t(`remote.device.failed.${failure}`)
  } catch (error) {
    return errorMessage(error)
  }
}

/** What a device is, for its icon: a phone, a tablet, a laptop, a desktop or a browser. */
export function deviceShape(
  device: Pick<PairedDevice, 'kind' | 'model'>,
): 'phone' | 'tablet' | 'laptop' | 'desktop' | 'web' {
  if (device.kind === 'web') return 'web'
  if (device.kind === 'desktop') return /book|laptop/i.test(device.model) ? 'laptop' : 'desktop'
  return /ipad|tablet/i.test(device.model) ? 'tablet' : 'phone'
}

/** The logo of the system a platform names (`process.platform`, or `ios` or `ipados`), else null. */
export function systemLogoOf(platform: string): SystemLogoName | null {
  switch (platform) {
    case 'ios':
    case 'ipados':
    case 'darwin':
      return 'apple'
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      return null
  }
}

/** A moment in a list: "Today 14:35", "Yesterday 22:10", "Oct 28, 09:15". */
export function whenAt(t: TFunction<'settings'>, at: number, now = Date.now()): string {
  const time = clockTime(at)
  const days = daysBefore(at, now)
  if (days === 0) return t('remote.time.today', { time })
  if (days === 1) return t('remote.time.yesterday', { time })
  return t('remote.time.date', { date: monthDay(at), time })
}

/** Whole days until a device not seen is removed, while its row should say so; else null. */
export function daysToRemoval(
  device: Pick<PairedDevice, 'addedAt' | 'lastConnectedAt'>,
  now = Date.now(),
): number | null {
  const left = removalAt(device) - now
  if (left > UNSEEN_NOTICE_DAYS * DAY) return null
  return Math.max(1, Math.ceil(left / DAY))
}

/** When an offline device last connected, as its row says it. */
export function lastSeen(
  t: TFunction<'settings'>,
  device: Pick<PairedDevice, 'lastConnectedAt'>,
  now = Date.now(),
): string {
  const at = device.lastConnectedAt
  if (at === null) return t('remote.devices.neverSeen')
  const days = daysBefore(at, now)
  if (days === 0) return t('remote.devices.seenToday', { time: clockTime(at) })
  if (days === 1) return t('remote.devices.seenYesterday', { time: clockTime(at) })
  return t('remote.devices.seenDaysAgo', { count: days })
}

/** Whole days since a device last connected, or since it joined if it never did. */
export function daysUnseen(
  device: Pick<PairedDevice, 'addedAt' | 'lastConnectedAt'>,
  now = Date.now(),
): number {
  return Math.floor((now - (device.lastConnectedAt ?? device.addedAt)) / DAY)
}

/** The port field's id, which Change port on the status line focuses. */
export const DIRECT_PORT_FIELD = 'remote-direct-port'

/** Focuses the port field, as Change port does when the port could not be opened. */
export function focusDirectPort(): void {
  document.getElementById(DIRECT_PORT_FIELD)?.focus()
}
