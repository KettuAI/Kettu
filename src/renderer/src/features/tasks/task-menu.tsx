import { Cancel01Icon, PauseIcon, PlayIcon } from '@hugeicons/core-free-icons'
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
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { useTasksStore } from '@renderer/stores/tasks'
import { runTaskAction, taskActions } from './model'

/** A task's actions, for its row's context menu and More menu alike. */
export function TaskMenuItems({ task, onCancel }: { task: TaskView; onCancel: () => void }) {
  const { t } = useTranslation('tasks')
  const can = taskActions(task)
  const store = useTasksStore.getState()
  return (
    <>
      {(can.start || can.pause || can.resume) && (
        <DropdownMenuGroup>
          {can.start && (
            <DropdownMenuItem onClick={() => runTaskAction(() => store.start(task.id))}>
              <MenuGlyph icon={PlayIcon} />
              {t('menu.start')}
            </DropdownMenuItem>
          )}
          {can.pause && (
            <DropdownMenuItem onClick={() => runTaskAction(() => store.pause(task.id))}>
              <MenuGlyph icon={PauseIcon} />
              {t('menu.pause')}
            </DropdownMenuItem>
          )}
          {can.resume && (
            <DropdownMenuItem onClick={() => runTaskAction(() => store.resume(task.id))}>
              <MenuGlyph icon={PlayIcon} />
              {t('menu.resume')}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      )}
      {can.cancel && (
        <DropdownMenuGroup>
          {(can.start || can.pause || can.resume) && <DropdownMenuSeparator />}
          <DropdownMenuItem variant="destructive" onClick={onCancel}>
            <MenuGlyph icon={Cancel01Icon} />
            {t('menu.cancel')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      )}
    </>
  )
}

/** Asks before a task is cancelled, since its working stage stops. */
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
