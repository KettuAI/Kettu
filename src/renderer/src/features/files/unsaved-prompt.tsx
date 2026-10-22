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
import { Button } from '@renderer/components/ui/button'
import { answerPending, useFilesStore } from '@renderer/stores/files'
import { nameOf } from './paths'

/** "Save changes?" before the open file with unsaved edits closes or gives way to another. */
export function UnsavedPrompt({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation(['files', 'common'])
  const pending = useFilesStore((s) => s.pending[projectPath] ?? null)
  const path = useFilesStore((s) => s.open[projectPath]?.path ?? null)
  return (
    <AlertDialog
      open={!!pending && !!path}
      onOpenChange={(open) => !open && void answerPending(projectPath, 'cancel')}
    >
      <AlertDialogContent className="sm:max-w-[380px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('unsaved.title', { name: nameOf(path ?? '') })}</AlertDialogTitle>
          <AlertDialogDescription>{t('unsaved.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <Button variant="outline" onClick={() => void answerPending(projectPath, 'discard')}>
            {t('unsaved.dontSave')}
          </Button>
          <AlertDialogAction onClick={() => void answerPending(projectPath, 'save')}>
            {t('unsaved.save')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
