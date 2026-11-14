import { useRef, useState, type CSSProperties } from 'react'
import {
  Archive01Icon,
  Delete02Icon,
  LinkSquare02Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  StopCircleIcon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TaskSummary } from '@shared/sop'
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
import { toast } from '@renderer/components/ui/toast'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { useTasksStore } from '@renderer/stores/tasks'
import { openTask, useViewStore } from '@renderer/stores/view'
import { updateTask } from './actions'

/** Archives with a toast that undoes it. */
function archiveTask(task: TaskSummary): void {
  void updateTask(task.id, { archived: true }).then(
    () =>
      toast(
        i18n.t('tasks:menu.archived', { title: task.title }),
        {
          label: i18n.t('sidebar:row.undo'),
          onClick: () => void updateTask(task.id, { archived: false }).catch(() => {}),
        },
        { icon: Archive01Icon },
      ),
    () => {},
  )
}

/**
 * A task's actions, for its row's context and More menus and its page's More menu: open, pin,
 * mark unread, rename, then archive and delete once it has ended, or cancel while it runs.
 */
export function TaskMenuItems({
  task,
  place = 'row',
  onRename,
  onCancel,
  onDelete,
}: {
  task: TaskSummary
  place?: 'row' | 'page'
  onRename?: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation(['tasks', 'sidebar'])
  const inFront = useViewStore(
    (s) => !s.settings.open && s.main.kind === 'task' && s.main.taskId === task.id,
  )
  const running = task.status === 'running'
  return (
    <>
      <DropdownMenuGroup>
        {place === 'row' && (
          <DropdownMenuItem disabled={inFront} onClick={() => openTask(task.id)}>
            <MenuGlyph icon={LinkSquare02Icon} />
            {t('sidebar:row.open')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => void updateTask(task.id, { pinned: !task.pinnedAt }).catch(() => {})}
        >
          <MenuGlyph icon={task.pinnedAt ? PinOffIcon : PinIcon} />
          {task.pinnedAt ? t('sidebar:row.unpin') : t('sidebar:row.pin')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={inFront}
          onClick={() => void updateTask(task.id, { unread: !task.unread }).catch(() => {})}
        >
          <MenuGlyph icon={ViewIcon} />
          {task.unread ? t('sidebar:row.markRead') : t('sidebar:row.markUnread')}
        </DropdownMenuItem>
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('sidebar:row.rename')}
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        {running ? (
          <DropdownMenuItem variant="destructive" onClick={onCancel}>
            <Glyph icon={StopCircleIcon} size={15} />
            {t('menu.cancel')}
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onClick={() => archiveTask(task)}>
              <MenuGlyph icon={Archive01Icon} />
              {t('sidebar:row.archive')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Glyph icon={Delete02Icon} size={15} />
              {t('sidebar:row.deleteMenu')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuGroup>
    </>
  )
}

/** Cancels a running task after a confirmation: its steps at work stop, and nothing is removed. */
export function CancelTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['tasks', 'common'])
  const cancel = async () => {
    onOpenChange(false)
    try {
      const view = await host('tasks.cancel', { taskId: task.id })
      useTasksStore.getState().receive(view, useTasksStore.getState().hosts[task.id] ?? null)
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('menu.cancelTitle', { title: task.title })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription className="text-small text-tertiary">
          {task.branch ? t('menu.cancelBodyBranch') : t('menu.cancelBody')}
        </AlertDialogDescription>
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>{t('menu.keepRunning')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void cancel()}>
            {t('menu.cancelConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Deletes an ended task with its steps' sessions, after a confirmation. */
export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  onDeleted,
}: {
  task: TaskSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const { t } = useTranslation(['tasks', 'sidebar', 'common'])
  const remove = async () => {
    onOpenChange(false)
    try {
      await host('tasks.delete', { taskId: task.id })
      useTasksStore.getState().removed(task.id)
      onDeleted?.()
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('sidebar:row.deleteTitle', { title: task.title })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription className="text-small text-tertiary">
          {task.branch ? t('menu.deleteBodyBranch', { branch: task.branch }) : t('menu.deleteBody')}
        </AlertDialogDescription>
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void remove()}>
            {t('sidebar:row.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The task's title as a text field: Enter or a blur saves it, Esc leaves it as it was. */
export function TaskTitleField({
  task,
  onDone,
  className,
  style,
}: {
  task: TaskSummary
  onDone: (restoreFocus: boolean) => void
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation('tasks')
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  // Enter, Esc and the blur that follows can all land on one edit; only the first counts.
  const settled = useRef(false)
  const finish = async (value: string | null, restoreFocus: boolean) => {
    if (settled.current) return
    settled.current = true
    const title = value?.trim() ?? ''
    if (!title || title === task.title) return onDone(restoreFocus)
    try {
      await updateTask(task.id, { title })
      onDone(restoreFocus)
    } catch (err) {
      settled.current = false
      setError(errorMessage(err))
      field.current?.focus()
    }
  }
  return (
    <input
      ref={field}
      autoFocus
      aria-label={t('menu.renameTitle')}
      aria-invalid={error !== null}
      title={error ?? undefined}
      defaultValue={task.title}
      maxLength={120}
      autoComplete="off"
      spellCheck={false}
      className={cn('min-w-0 outline-none', className)}
      style={style}
      onFocus={(event) => event.currentTarget.select()}
      onChange={() => setError(null)}
      onBlur={(event) => void finish(error ? null : event.currentTarget.value, false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void finish(event.currentTarget.value, true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          void finish(null, true)
        }
      }}
    />
  )
}
