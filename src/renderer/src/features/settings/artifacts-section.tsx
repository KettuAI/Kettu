import { useState } from 'react'
import { DashboardSquare02Icon, RefreshIcon, ShapesIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ArtifactConsentRow } from '@shared/artifact-capabilities'
import { Icon } from '@renderer/components/affect/app-shell'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, Pill, SetButton, Spin } from './controls'
import { ItemLine, Notice, Thing } from './rows'

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
    <div className="ui-sg-row">
      <Thing
        mark={<Icon icon={ShapesIcon} size={20} />}
        name={<span className="k-name">{row.title}</span>}
      >
        <ItemLine>{where}</ItemLine>
      </Thing>
      <span className="ui-sg-control">
        <ControlError error={error} />
        {row.capabilities.map((capability) => (
          <Pill key={capability}>
            {capability === 'files'
              ? t('artifacts.files')
              : t('artifacts.sample', { agent: row.agent ?? t('artifacts.yourAgent') })}
          </Pill>
        ))}
        <SetButton loading={busy} onClick={() => void revoke()}>
          {t('artifacts.revoke')}
        </SetButton>
      </span>
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
      <div className="k-loading">
        <Spin />
        {t('artifacts.loading')}
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <Notice
        variant="error"
        className="k-pending"
        title={t('artifacts.loadFailed', { error: error ?? '' })}
        action={
          <SetButton icon={<Icon icon={RefreshIcon} size={14} />} onClick={onRetry}>
            {t('artifacts.retry')}
          </SetButton>
        }
      />
    )
  }
  return (
    <div className="ui-as-empty">
      <span className="ui-as-empty__icon">
        <Icon icon={DashboardSquare02Icon} size={18} />
      </span>
      <b className="ui-as-empty__title">{t('artifacts.emptyTitle')}</b>
      <p className="ui-as-empty__text">{t('artifacts.emptyHint')}</p>
    </div>
  )
}
