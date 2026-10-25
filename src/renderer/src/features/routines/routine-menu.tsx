// The actions a routine offers, in its row's context menu and in its page's More menu.

import { CopyIcon, PlayIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RoutineView } from '@shared/routines'
import { DropdownMenuItem, DropdownMenuSeparator } from '@renderer/components/ui/dropdown-menu'
import { errorMessage } from '@renderer/lib/host'
import { duplicateRoutine } from './actions'

export function RoutineMenuItems({
  routine,
  onRunNow,
  onDelete,
  onError,
}: {
  routine: RoutineView
  /** Absent on the routine's page, which has Run now as its own button. */
  onRunNow?: () => void
  onDelete: () => void
  onError?: (message: string) => void
}) {
  const { t } = useTranslation('routines')
  const duplicate = () => {
    duplicateRoutine(routine).catch((error: unknown) => {
      const message = errorMessage(error)
      if (onError) onError(message)
      else console.warn(`Could not duplicate the routine: ${message}`)
    })
  }

  return (
    <>
      {onRunNow && (
        <DropdownMenuItem disabled={!!routine.activeRun} onClick={onRunNow}>
          <PlayIcon />
          {t('routine.runNow')}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={duplicate}>
        <CopyIcon />
        {t('routine.duplicate')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2Icon />
        {t('routine.delete')}
      </DropdownMenuItem>
    </>
  )
}
