import { useState } from 'react'
import { ShapesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArtifactConsentRow } from '@shared/artifact-capabilities'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, GROUP_ACTION, Pill, ROW_BUTTON } from './controls'
import { DeviceTile } from './remote-parts'
import { ItemLine } from './rows'

/** An artifact the user allowed something: what, and Revoke, which takes all of it back. */
export function ConsentRow({ row, where }: { row: ArtifactConsentRow; where: string }) {
  const { t } = useTranslation('settings')
  const { request } = useHostScope()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await request('artifacts.revokeConsent', { id: row.artifactId })
      toast(t('artifacts.revoked', { title: row.title }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-3.5 py-3.25">
      <DeviceTile icon={<ShapesIcon className="size-4.25" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-[normal]">{row.title}</span>
        <ItemLine>{where}</ItemLine>
      </div>
      <ControlError error={error} />
      <div className="flex shrink-0 items-center gap-2">
        {row.capabilities.map((capability) => (
          <Pill key={capability}>
            {capability === 'files'
              ? t('artifacts.files')
              : t('artifacts.sample', { agent: row.agent ?? t('artifacts.yourAgent') })}
          </Pill>
        ))}
        <Button
          variant="outline"
          className={ROW_BUTTON}
          disabled={busy}
          onClick={() => void revoke()}
        >
          {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t('artifacts.revoke')}
        </Button>
      </div>
    </div>
  )
}

/** In place of the list while it is read, could not be read, or holds nothing. */
export function ConsentsState({
  state,
  error,
  onRetry,
}: {
  state: 'loading' | 'failed' | 'empty'
  error?: string | null
  onRetry?: () => void
}) {
  const { t } = useTranslation('settings')
  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-group text-tertiary">
        <Spinner className="size-3.5" />
        {t('artifacts.loading')}
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div className="flex items-center gap-3 py-6">
        <span className="text-group text-danger">
          {t('artifacts.loadFailed', { error: error ?? '' })}
        </span>
        <Button variant="ghost" className={GROUP_ACTION} onClick={onRetry}>
          {t('artifacts.retry')}
        </Button>
      </div>
    )
  }
  return (
    <Empty className="px-6 py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShapesIcon />
        </EmptyMedia>
        <EmptyTitle>{t('artifacts.emptyTitle')}</EmptyTitle>
        <EmptyDescription>{t('artifacts.emptyHint')}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
