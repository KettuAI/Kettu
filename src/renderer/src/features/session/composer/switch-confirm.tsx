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

/**
 * Asks before a message hands the session to another agent while its own still runs background
 * work, which stops with the agent's session. Cancel leaves the message in the composer.
 */
export function SwitchConfirm({
  items,
  agentName,
  currentName,
  onAnswer,
}: {
  /** What stops; null while nothing is asked. */
  items: WorkItem[] | null
  agentName: string
  currentName: string
  onAnswer: (go: boolean) => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  return (
    <AlertDialog open={items !== null} onOpenChange={(open) => !open && onAnswer(false)}>
      <AlertDialogContent className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('switchAgent.stopTitle', { agent: agentName })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('switchAgent.stopBody', { current: currentName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RunningWorkList items={items ?? []} className="mt-3.5" />
        <AlertDialogFooter className="mt-4.5">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onAnswer(true)}>
            {t('switchAgent.stopConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
