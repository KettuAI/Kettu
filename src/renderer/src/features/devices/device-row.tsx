import { useTranslation } from 'react-i18next'
import type { DeviceInfo } from '@shared/device-host'
import { Badge } from '@renderer/components/ui/badge'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { cn } from '@renderer/lib/utils'
import { markOf, rowOf } from './device-marks'

const DOT_COLOR = {
  neutral: 'text-tertiary',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-danger',
} as const

/** A state as a badge, with a dot for one that is happening now. */
function State({
  variant,
  dot,
  compact,
  children,
}: {
  variant: 'neutral' | 'info' | 'warning' | 'error'
  dot?: 'still' | 'live'
  /** Only a dot in the state's color, where a tab has no room for the words. */
  compact?: boolean
  children: string
}) {
  if (compact) {
    return (
      <span
        role="img"
        aria-label={children}
        className={cn('kp-tab__dot kp-device-dot', DOT_COLOR[variant])}
      />
    )
  }
  return (
    <Badge variant={variant} className="kp-device-state">
      {dot && <span aria-hidden data-live={dot === 'live' || undefined} />}
      {children}
    </Badge>
  )
}

const ROW_VARIANT = {
  shutdown: 'neutral',
  unavailable: 'neutral',
  plugIn: 'warning',
  notAllowed: 'warning',
  elsewhere: 'info',
} as const

/** A device's row in the add menu and in the empty pane: its mark, name and state. */
export function DeviceRow({ device }: { device: DeviceInfo }) {
  const { t } = useTranslation('devices')
  const { state } = rowOf(device)
  return (
    <>
      <PaneIcon icon={markOf(device)} size={16} />
      <span className="min-w-0 flex-1 truncate" title={device.name}>
        {device.name}
      </span>
      {state && <State variant={ROW_VARIANT[state]}>{t(`row.${state}`)}</State>}
      {state === 'elsewhere' && <span className="kp-device-move">{t('row.move')}</span>}
    </>
  )
}
