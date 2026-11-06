// The actions a routine offers, in its row's context menu and More menu, and in its page's.

import {
  ArrowUpRight01Icon,
  Delete02Icon,
  PlayIcon,
  ToggleOffIcon,
  ToggleOnIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RoutineView } from '@shared/routines'
import { Icon } from '@renderer/components/affect/app-shell'
import { DropdownMenuItem, DropdownMenuSeparator } from '@renderer/components/ui/dropdown-menu'
import type { MenuActions } from './menu-items'

/** The same actions as a context menu's items. */
export function RoutineMenuItems({
  routine,
  onOpen,
  onRunNow,
  onToggle,
  onDelete,
}: { routine: RoutineView } & MenuActions) {
  const { t } = useTranslation('routines')
  const actions = !!(onOpen || onRunNow || onToggle)
  return (
    <>
      {onOpen && (
        <DropdownMenuItem onClick={onOpen}>
          <Icon icon={ArrowUpRight01Icon} size={15} />
          {t('menu.open')}
        </DropdownMenuItem>
      )}
      {onRunNow && (
        <DropdownMenuItem disabled={!!routine.activeRun} onClick={onRunNow}>
          <Icon icon={PlayIcon} size={15} />
          {t('routine.runNow')}
        </DropdownMenuItem>
      )}
      {onToggle && (
        <DropdownMenuItem onClick={() => onToggle(!routine.enabled)}>
          <Icon icon={routine.enabled ? ToggleOffIcon : ToggleOnIcon} size={15} />
          {t(routine.enabled ? 'menu.turnOff' : 'menu.turnOn')}
        </DropdownMenuItem>
      )}
      {actions && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Icon icon={Delete02Icon} size={15} />
        {t('routine.delete')}
      </DropdownMenuItem>
    </>
  )
}
