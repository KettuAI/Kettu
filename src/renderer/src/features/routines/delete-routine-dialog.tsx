// The one confirmation a routine's deletion asks, naming the sessions that go with it.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoutineView } from '@shared/routines'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { errorMessage } from '@renderer/lib/host'
import { useRoutinesStore } from '@renderer/stores/routines'

export function DeleteRoutineDialog({
  routine,
  open,
  onOpenChange,
  onDeleted,
}: {
  routine: RoutineView
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const { t } = useTranslation('routines')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setDeleting(true)
    setError(null)
    try {
      await useRoutinesStore.getState().remove(routine.id)
      onOpenChange(false)
      onDeleted?.()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (deleting) return
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('routine.deleteTitle', { name: routine.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {routine.sessions > 0
              ? t('routine.deleteWithSessions', { count: routine.sessions })
              : t('routine.deleteNoSessions')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {t('routine.deleteFailed', { error })}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t('routine.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => void remove()}
          >
            {t('routine.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
