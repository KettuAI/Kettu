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

/** "Save changes?" before a tab with unsaved edits closes. */
export function UnsavedPrompt({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation(['files', 'common'])
  const path = useFilesStore((s) => s.pending[projectPath]?.path ?? null)
  return (
    <AlertDialog
      open={path !== null}
      onOpenChange={(open) => !open && void answerPending(projectPath, 'cancel')}
    >
      <AlertDialogContent className="sm:max-w-[380px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('unsaved.title', { name: nameOf(path ?? '') })}</AlertDialogTitle>
          <AlertDialogDescription>{t('unsaved.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        {/* As macOS lays it out: Don't Save apart on the left, away from Save. */}
        <AlertDialogFooter>
          <Button
            variant="outline"
            size="dialog"
            className="sm:mr-auto"
            onClick={() => void answerPending(projectPath, 'discard')}
          >
            {t('unsaved.dontSave')}
          </Button>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void answerPending(projectPath, 'save')}>
            {t('unsaved.save')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
