// The words and figures a host's load is shown in, shared by Settings, the sidebar and New
// session's host menu.

import type { TFunction } from 'i18next'
import type { HostLoad, HostStrain } from '@shared/host-load'
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

/** The short words of a strain's tag: "Memory low", "Disk almost full", "Battery 18%". */
export function strainText(t: TFunction<'settings'>, strain: HostStrain): string {
  if (strain.kind === 'battery') return t('hosts.load.strain.battery', { percent: strain.value })
  return t(`hosts.load.strain.${strain.kind}`)
}

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
