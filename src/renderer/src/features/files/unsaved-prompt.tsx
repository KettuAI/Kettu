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

/**
 * "Save changes?" before a file tab of the panel with unsaved edits closes; `onClose` closes the
 * tab once the answer lets it.
 */
export function UnsavedPrompt({
  panel,
  onClose,
}: {
  panel: string
  onClose: (path: string) => void
}) {
  const { t } = useTranslation(['files', 'common'])
  const path = useFilesStore((s) => (s.pending?.panel === panel ? s.pending.path : null))
  const answer = (choice: 'cancel' | 'discard' | 'save'): void =>
    void answerPending(choice).then((closing) => closing && onClose(closing.path))
  return (
    <AlertDialog open={path !== null} onOpenChange={(open) => !open && answer('cancel')}>
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
            onClick={() => answer('discard')}
          >
            {t('unsaved.dontSave')}
          </Button>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer('save')}>{t('unsaved.save')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
