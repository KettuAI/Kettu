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
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { monthDayTime } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import type { CardResets } from '@renderer/lib/plan-readings'
import { spendReset } from '@renderer/stores/usage'

/**
 * Asks before one of an account's reset credits is spent, which cannot be undone: it names the
 * account and the credit that goes, the soonest to run out unless another is picked. Mounted only
 * while open, so each opening has one request id and a retry in it spends no second credit.
 */
export function SpendResetDialog({
  account,
  resets,
  each,
  onClose,
}: {
  /** What tells the account: its email, else the card's name. */
  account: string
  resets: CardResets
  each: NonNullable<CardResets['each']>
  onClose: () => void
}) {
  const { t } = useTranslation(['usage', 'common'])
  const [requestId] = useState(() => crypto.randomUUID())
  const [picked, setPicked] = useState(each[0]!.id)
  const [busy, setBusy] = useState(false)
  const expiry = (until: number | null) =>
    until === null ? t('resets.neverTile') : t('resets.runsOut', { time: monthDayTime(until) })
  const spend = async () => {
    setBusy(true)
    try {
      const { code } = await spendReset(resets.hostId, resets.agentId, picked, requestId)
      toast(t(`resets.result.${code}`, { account }))
      onClose()
    } catch (error) {
      toast(errorMessage(error))
      setBusy(false)
    }
  }
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('resets.confirm.title')}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription className="text-small text-tertiary">
          {t('resets.confirm.body', { account })}{' '}
          {each.length === 1 &&
            (each[0]!.until === null
              ? t('resets.confirm.oneNever')
              : t('resets.confirm.one', { time: monthDayTime(each[0]!.until) }))}
        </AlertDialogDescription>
        {each.length > 1 && (
          <RadioGroup
            aria-label={t('resets.confirm.which')}
            value={picked}
            onValueChange={(id) => setPicked(id as string)}
            disabled={busy}
          >
            {each.map((credit, index) => (
              <RadioGroupTile key={credit.id} value={credit.id}>
                {expiry(credit.until)}
                {index === 0 && credit.until !== null && (
                  <span className="text-tertiary"> · {t('resets.confirm.soonest')}</span>
                )}
              </RadioGroupTile>
            ))}
          </RadioGroup>
        )}
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel disabled={busy}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => void spend()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t('resets.confirm.use')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
