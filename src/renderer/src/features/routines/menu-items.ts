// The actions a routine offers, as the shell's menu lists them.

import {
  ArrowUpRight01Icon,
  Delete02Icon,
  PlayIcon,
  ToggleOffIcon,
  ToggleOnIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import type { RoutineView } from '@shared/routines'
import type { MenuItem } from '@renderer/components/affect/app-shell'

export interface MenuActions {
  /** The list's; the routine's page is already open. */
  onOpen?: () => void
  /** The list's; the page has Run now and its switch as buttons of their own. */
  onRunNow?: () => void
  onToggle?: (enabled: boolean) => void
  onDelete: () => void
}

/** The actions as the shell's menu lists them. A run at work leaves Run now out. */
export function routineMenu(
  routine: RoutineView,
  t: TFunction<'routines'>,
  { onOpen, onRunNow, onToggle, onDelete }: MenuActions,
): MenuItem[] {
  const items: MenuItem[] = []
  if (onOpen) items.push({ label: t('menu.open'), icon: ArrowUpRight01Icon, onSelect: onOpen })
  if (onRunNow && !routine.activeRun)
    items.push({ label: t('routine.runNow'), icon: PlayIcon, onSelect: onRunNow })
  if (onToggle)
    items.push({
      label: t(routine.enabled ? 'menu.turnOff' : 'menu.turnOn'),
      icon: routine.enabled ? ToggleOffIcon : ToggleOnIcon,
      onSelect: () => onToggle(!routine.enabled),
    })
  items.push({
    label: t('routine.delete'),
    icon: Delete02Icon,
    danger: true,
    divider: items.length > 0,
    onSelect: onDelete,
  })
  return items
}
