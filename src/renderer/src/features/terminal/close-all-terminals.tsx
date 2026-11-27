import { useState } from 'react'
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
import type { WorkItem } from '@renderer/features/sidebar/running-work'
import { RunningWorkList } from '@renderer/features/sidebar/running-work-list'
import {
  useCloseAllTerminalsQuestion,
  type CloseAllTerminalsQuestion,
} from './close-all-terminals-model'

/** Confirmation dialog shown before closing all terminals of a session when any command runs. */
export function CloseAllTerminalsDialog() {
  const { t } = useTranslation(['terminal', 'common'])
  const question = useCloseAllTerminalsQuestion((s) => s.question)
  // Keep the previous question rendered while the dialog fades out.
  const [shown, setShown] = useState<CloseAllTerminalsQuestion | null>(null)
  if (question && question !== shown) setShown(question)
  const answer = (confirmed: boolean) => {
    question?.answer(confirmed)
    useCloseAllTerminalsQuestion.setState({ question: null })
  }
  const running = shown?.running ?? []
  const items: WorkItem[] = running.map((terminal) => ({
    key: `terminal:${terminal.id}`,
    kind: 'terminal',
    name: terminal.name ?? (terminal.title || terminal.shell),
    count: 0,
    agentId: null,
    hostId: null,
    sessionId: terminal.sessionId,
  }))
  return (
    <AlertDialog open={!!question} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('closeAll.title', { count: running.length })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('closeAll.body', { count: running.length })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RunningWorkList items={items} className="mt-3.5" />
        <AlertDialogFooter className="mt-4.5">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => answer(true)}>
            {t('closeAll.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
