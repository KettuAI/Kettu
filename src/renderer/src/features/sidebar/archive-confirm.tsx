import { Trans, useTranslation } from 'react-i18next'
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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('row.archiveRunningTitle', { count: question?.sessions ?? 1 })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans
              t={t}
              i18nKey="row.archiveRunningBody"
              values={{ commands: question?.commands.join(', ') ?? '' }}
              components={{ command: <span className="font-mono text-xs text-primary" /> }}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => answer(true)}>
            {t('row.archiveRunningConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
