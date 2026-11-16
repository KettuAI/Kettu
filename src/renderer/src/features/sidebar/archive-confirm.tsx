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
import { useArchiveQuestion } from './archive-confirm-model'
import { RunningWorkList } from './running-work-list'

/** The question `confirmArchive` asks, mounted once for the window. */
export function ArchiveConfirmDialog() {
  const { t } = useTranslation(['sidebar', 'common'])
  const question = useArchiveQuestion((s) => s.question)
  const answer = (archive: boolean) => {
    question?.answer(archive)
    useArchiveQuestion.setState({ question: null })
  }
  return (
    <AlertDialog open={!!question} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('row.archiveRunningTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('row.archiveRunningBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <RunningWorkList items={question?.items ?? []} className="mt-3.5" />
        <AlertDialogFooter className="mt-4.5">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => answer(true)}>
            {t('row.archiveRunningConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
