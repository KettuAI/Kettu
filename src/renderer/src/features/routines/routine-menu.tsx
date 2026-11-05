// The actions a routine offers, in its row's context menu and More menu, and in its page's.

import { ArrowUpRightIcon, PlayIcon, PowerIcon, TrashIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RoutineView } from '@shared/routines'
import { DropdownMenuItem, DropdownMenuSeparator } from '@renderer/components/ui/dropdown-menu'

export function RoutineMenuItems({
  routine,
  onOpen,
  onRunNow,
  onToggle,
  onDelete,
}: {
  routine: RoutineView
  /** The list's; the routine's page is already open. */
  onOpen?: () => void
  /** The list's; the page has Run now and its switch as buttons of their own. */
  onRunNow?: () => void
  onToggle?: (enabled: boolean) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('routines')
  const actions = !!(onOpen || onRunNow || onToggle)
  return (
    <>
      {onOpen && (
        <DropdownMenuItem onClick={onOpen}>
          <ArrowUpRightIcon />
          {t('menu.open')}
        </DropdownMenuItem>
      )}
      {onRunNow && (
        <DropdownMenuItem disabled={!!routine.activeRun} onClick={onRunNow}>
          <PlayIcon />
          {t('routine.runNow')}
        </DropdownMenuItem>
      )}
      {onToggle && (
        <DropdownMenuItem onClick={() => onToggle(!routine.enabled)}>
          <PowerIcon />
          {t(routine.enabled ? 'menu.turnOff' : 'menu.turnOn')}
        </DropdownMenuItem>
      )}
      {actions && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <TrashIcon />
        {t('routine.delete')}
      </DropdownMenuItem>
    </>
  )
}
