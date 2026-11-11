import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SopSummary } from '@shared/tasks'
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
import { ControlError, SetButton, Skel } from '@renderer/features/settings/controls'
import { BlockLine, RowText } from '@renderer/features/settings/rows'
import { errorMessage } from '@renderer/lib/host'
import { hostKey, useTasksStore } from '@renderer/stores/tasks'
import { sopOrigin } from './model'
import { SopFlow } from './sop-flow'
import './tasks.css'

/**
 * One SOP in Settings: its name, where it is from and what it is for, its flowchart on demand,
 * Approve while the person has not approved it as it is, and Remove for one of the library's.
 */
export function SopRow({ sop, hostId }: { sop: SopSummary; hostId: string | null }) {
  const { t } = useTranslation('tasks')
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = sop.status === 'pending'

  const run = (request: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    request()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="k-block">
      <BlockLine
        text={
          <RowText
            name={`${sop.name} · ${t(`sop.origin.${sopOrigin(sop)}`)}`}
            description={sop.description}
          />
        }
      >
        <ControlError error={error} />
        {sop.outline && (
          <SetButton variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('settings.sops.hideFlow') : t('settings.sops.showFlow')}
          </SetButton>
        )}
        {pending && sop.problem === null && (
          <SetButton
            variant="primary"
            disabled={busy}
            onClick={() => run(() => useTasksStore.getState().approveSop(hostId, sop.id, sop.hash))}
          >
            {t('settings.sops.approve')}
          </SetButton>
        )}
        {sop.source === 'library' && (
          <SetButton disabled={busy} onClick={() => setRemoving(true)}>
            {t('settings.sops.remove')}
          </SetButton>
        )}
      </BlockLine>
      {sop.problem !== null && (
        <p role="alert" className="text-xs text-danger">
          {t('settings.sops.broken', { problem: sop.problem })}
        </p>
      )}
      {pending && sop.problem === null && (
        <p role="status" className="text-xs text-(--tone-amber)">
          {sop.madeBy === 'agent'
            ? t('settings.sops.pendingAgent')
            : t('settings.sops.pendingChanged')}
        </p>
      )}
      {open && sop.outline && (
        <div className="k-sop__flow">
          <SopFlow outline={sop.outline} hostId={hostId} />
        </div>
      )}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.sops.removeTitle', { name: sop.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('settings.sops.removeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.sops.keep')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run(() => useTasksStore.getState().removeSop(hostId, sop.id))}
            >
              {t('settings.sops.removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** In place of the SOPs while there are none to list: reading, failed, or none. */
export function SopListState({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation('tasks')
  const list = useTasksStore((s) => s.sops[hostKey(hostId)])
  if (list?.error) {
    return (
      <div className="k-block">
        <BlockLine
          text={
            <span role="alert" className="text-xs text-danger">
              {t('settings.sops.failed', { error: list.error })}
            </span>
          }
        >
          <SetButton onClick={() => void useTasksStore.getState().loadSops(hostId)}>
            {t('settings.sops.retry')}
          </SetButton>
        </BlockLine>
      </div>
    )
  }
  if (!list?.value) {
    return (
      <div className="k-block" aria-busy aria-label={t('settings.sops.loading')}>
        <Skel width={220} />
      </div>
    )
  }
  return (
    <div className="k-block">
      <p className="k-muted">{t('settings.sops.empty')}</p>
    </div>
  )
}
