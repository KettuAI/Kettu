// The words devices are told a computer runs low in, written by the desktop app or the daemon in
// its own language, since they know the name devices show the computer by.

import type { HostToMain } from '@shared/host-control'
import { diskBytes, type HostStrain } from '@shared/host-load'
import { t } from './i18n'

type RunningLow = Extract<HostToMain, { type: 'host:attention'; kind: 'computer-low' }>

export function runningLowAttention(strain: HostStrain, host: string): RunningLow {
  const critical = strain.level === 'critical'
  const body =
    strain.kind === 'battery'
      ? t(critical ? 'notifications.lowBatteryCritical' : 'notifications.lowBattery', {
          percent: strain.value,
        })
      : t(critical ? 'notifications.lowDiskCritical' : 'notifications.lowDisk', {
          free: diskBytes(strain.value),
          path: strain.path ?? '',
        })
  return {
    type: 'host:attention',
    kind: 'computer-low',
    strain,
    title: t('notifications.lowTitle', { host }),
    body,
  }
}
