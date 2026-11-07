// The one-time notice before Kettu publishes an artifact on its own: nothing is uploaded until the
// user answers it. Closing it with Escape only hides it until the next launch.

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
import { setAutoPublish, useSharingStore } from '@renderer/stores/sharing'

export function AutoPublishNotice() {
  const { t } = useTranslation('artifacts')
  const waiting = useSharingStore((s) => s.status?.auto.notice === true)
  const [hidden, setHidden] = useState(false)
  const answer = (enabled: boolean): void => {
    void setAutoPublish(enabled)
  }
  return (
    <AlertDialog open={waiting && !hidden} onOpenChange={(open) => !open && setHidden(true)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('share.autoNotice.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('share.autoNotice.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>
            {t('share.autoNotice.turnOff')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>
            {t('share.autoNotice.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
