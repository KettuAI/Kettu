import { Cancel01Icon, Delete02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TaskView } from '@shared/tasks'
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
import { DropdownMenuGroup, DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { useTasksStore } from '@renderer/stores/tasks'
import { runTaskAction, taskActions } from './model'

/** A task's actions, for its row's context menu and More menu alike: Cancel, or Remove once ended. */
export function TaskMenuItems({
  task,
  onCancel,
  onRemove,
}: {
  task: TaskView
  onCancel: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('tasks')
  const can = taskActions(task)
  return (
    <DropdownMenuGroup>
      {can.cancel && (
        <DropdownMenuItem variant="destructive" onClick={onCancel}>
          <MenuGlyph icon={Cancel01Icon} />
          {t('menu.cancel')}
        </DropdownMenuItem>
      )}
      {can.remove && (
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <MenuGlyph icon={Delete02Icon} />
          {t('menu.remove')}
        </DropdownMenuItem>
      )}
    </DropdownMenuGroup>
  )
}

/** Asks before a task is cancelled, since its working nodes stop. */
export function CancelTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskView
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('tasks')
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('cancel.title', { title: task.title })}</AlertDialogTitle>
          <AlertDialogDescription>{t('cancel.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel.keep')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => runTaskAction(() => useTasksStore.getState().cancel(task.id))}
          >
            {t('cancel.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Asks before an ended task is removed, since what its nodes handed in goes with it. */
export function RemoveTaskDialog({
  task,
  open,
  onOpenChange,
  onRemoved,
}: {
  task: TaskView
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved?: () => void
}) {
  const { t } = useTranslation('tasks')
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('remove.title', { title: task.title })}</AlertDialogTitle>
          <AlertDialogDescription>{t('remove.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('remove.keep')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              runTaskAction(async () => {
                await useTasksStore.getState().remove(task.id)
                onRemoved?.()
              })
            }
          >
            {t('remove.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
