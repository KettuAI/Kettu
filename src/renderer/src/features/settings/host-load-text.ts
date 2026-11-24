// The words and figures a host's load is shown in, shared by Settings and New session's host menu.

import {
  BATTERY_CRITICAL_PERCENT,
  BATTERY_WARN_PERCENT,
  DISK_CRITICAL_BYTES,
  DISK_WARN_BYTES,
  type HostBattery,
  type HostLoad,
} from '@shared/host-load'
import type { LimitLevel } from '@renderer/lib/plan-limit'

/** Disk space in decimal units, as Finder and drive makers count it: "6.4 GB", "994 GB". */
export function diskBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unit]}`
}

/** Bytes per second in decimal units: "12 MB/s", "320 KB/s"; a dash when it was not read. */
export const rateText = (n: number | undefined): string =>
  n === undefined ? '–' : `${diskBytes(n)}/s`

/** A whole percent, with "<1%" for a sliver so it never reads as idle. */
export const wholePercent = (value: number): string =>
  value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`

export const memoryShare = (load: HostLoad): number =>
  load.memory.total > 0 ? (load.memory.used / load.memory.total) * 100 : 0

/** Memory's bar turns yellow when the system finds it tight and red when critical. */
export function memoryLevel(load: HostLoad): LimitLevel {
  return load.memory.state === 'critical' ? 'bad' : load.memory.state === 'tight' ? 'warn' : 'ok'
}

/** Memory in binary units, as systems count it, moving up a unit at 1000: "820 MB", "1.1 GB". */
export function memoryBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1024
    unit++
  }
  const digits = unit < 2 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unit]}`
}

/** The disk's bar turns yellow under 10 GB free and red under 2 GB. */
export function diskLevel(free: number): LimitLevel {
  return free < DISK_CRITICAL_BYTES ? 'bad' : free < DISK_WARN_BYTES ? 'warn' : 'ok'
}

/** On battery, the battery turns yellow at 20% or less and red at 10% or less. */
export function batteryLevel(battery: HostBattery): LimitLevel {
  if (!battery.onBattery || battery.percent === undefined) return 'ok'
  if (battery.percent <= BATTERY_CRITICAL_PERCENT) return 'bad'
  return battery.percent <= BATTERY_WARN_PERCENT ? 'warn' : 'ok'
}
