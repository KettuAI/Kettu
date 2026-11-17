import { useTranslation } from 'react-i18next'
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
import { isMac, isWindows } from '@renderer/lib/platform'
import { nameOf } from './paths'

/** Files and folders the user asked to delete, and whether it is for good now. */
export interface Deleting {
  paths: string[]
  /** The host could put them in no trash, so the delete cannot be undone. */
  permanently: boolean
  /** Open files among them whose edits are not saved, which go with them. */
  unsaved: string[]
}

/** Asks before files and folders go to the trash, and again before they go for good. */
export function DeletePrompt({
  deleting,
  onAnswer,
}: {
  deleting: Deleting | null
  onAnswer: (confirmed: boolean) => void
}) {
  const { t } = useTranslation(['files', 'common'])
  const paths = deleting?.paths ?? []
  const what =
    paths.length === 1 ? { name: nameOf(paths[0]!) } : { count: paths.length, name: undefined }
  const trash = t(isMac ? 'tree.trash.mac' : isWindows ? 'tree.trash.windows' : 'tree.trash.linux')
  return (
    <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && onAnswer(false)}>
      <AlertDialogContent className="sm:max-w-[400px]">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deleting?.permanently
              ? what.name
                ? t('tree.deleteForGoodOne', { name: what.name })
                : t('tree.deleteForGoodMany', { count: what.count })
              : what.name
                ? t('tree.deleteOne', { name: what.name })
                : t('tree.deleteMany', { count: what.count })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting?.permanently ? t('tree.noTrash') : t('tree.toTrash', { trash })}
            {!!deleting?.unsaved.length &&
              ` ${t('tree.unsavedGo', { names: deleting.unsaved.map(nameOf).join(', ') })}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onAnswer(true)}>
            {deleting?.permanently ? t('tree.deleteForGood') : t('tree.moveToTrash', { trash })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
