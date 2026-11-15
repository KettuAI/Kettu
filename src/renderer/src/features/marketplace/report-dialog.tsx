// Reporting a listing of the Kettu Marketplace: a short message about it, which sends nothing else.

import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MarketListing } from '@shared/market-publish'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { SetButton } from '@renderer/features/settings/controls'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from '@renderer/features/settings/settings-dialog'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { reportCommunity } from './actions'

// The most a report says, as the service takes it.
const REPORT_CHARS = 2000

/** A short message about the listing to the Kettu Marketplace, which sends nothing else. */
export function ReportDialog({
  listing,
  open,
  onOpenChange,
}: {
  listing: Pick<MarketListing, 'id' | 'name'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <ReportForm listing={listing} onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function ReportForm({
  listing,
  onDone,
}: {
  listing: Pick<MarketListing, 'id' | 'name'>
  onDone: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const id = useId()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = message.trim() !== ''
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await reportCommunity(scope, listing.id, message.trim())
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('community.reportTitle', { name: listing.name })}>
        {t('community.reportDescription')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('community.reportLabel')}
          htmlFor={`${id}-message`}
          hint={error ?? undefined}
        >
          <Textarea
            id={`${id}-message`}
            autoFocus
            rows={5}
            maxLength={REPORT_CHARS}
            placeholder={t('community.reportPlaceholder')}
            value={message}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setMessage(event.target.value)}
          />
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!ready}>
          {t('community.reportSend')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}
