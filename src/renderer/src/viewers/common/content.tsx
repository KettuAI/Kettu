// The controls a viewer edits its content with: Edit, the bar while editing, and what a save did.

import { PencilIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import type { SaveStatus } from './use-content'

/** The Edit button at the page's top right, while the content may be edited. */
export function EditButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('viewers')
  return (
    <Button
      variant="outline"
      size="compact"
      aria-label={t('edit.startLabel')}
      onClick={onClick}
      className="fixed top-3 right-3 z-20 bg-popover shadow-float"
    >
      <PencilIcon />
      {t('edit.start')}
    </Button>
  )
}

/** The bar over the bottom of the page while editing: what to do, Discard and Save. */
export function EditBar({
  hint,
  dirty,
  head,
  status,
  onDiscard,
  onSave,
  className,
}: {
  hint: string
  dirty: boolean
  head: number
  status: SaveStatus
  onDiscard: () => void
  onSave: () => void
  className?: string
}) {
  const { t } = useTranslation('viewers')
  const saving = status.kind === 'saving'
  return (
    <div
      role="toolbar"
      aria-label={t('edit.start')}
      className={cn(
        'fixed inset-x-0 bottom-4 z-20 mx-auto flex w-max max-w-[calc(100%-2rem)] items-center gap-3 rounded-xl bg-popover py-1.5 pr-1.5 pl-3.5 text-ui shadow-menu',
        className,
      )}
    >
      <span className="min-w-0 text-secondary">{hint}</span>
      <Button variant="ghost" size="compact" onClick={onDiscard} disabled={saving}>
        {t('edit.discard')}
      </Button>
      <Button size="compact" onClick={onSave} disabled={!dirty || saving}>
        {saving && <Spinner />}
        {saving ? t('edit.saving') : t('edit.save', { version: head + 1 })}
      </Button>
    </div>
  )
}

/** What became of the last save, until it is dismissed or the page loads the new version. */
export function SaveNotice({ status, onDismiss }: { status: SaveStatus; onDismiss: () => void }) {
  const { t } = useTranslation('viewers')
  const text =
    status.kind === 'saved'
      ? t('edit.saved', { version: status.version })
      : status.kind === 'conflict'
        ? t('edit.conflict')
        : status.kind === 'invalid'
          ? t('edit.invalid', { reason: status.reason })
          : status.kind === 'failed'
            ? t('edit.failed')
            : null
  if (!text) return null
  const problem = status.kind !== 'saved'
  return (
    <div
      role={problem ? 'alert' : 'status'}
      className="fixed inset-x-0 top-3 z-30 mx-auto flex w-max max-w-[calc(100%-2rem)] items-center gap-2.5 rounded-xl bg-popover py-1.5 pr-1.5 pl-3.5 text-ui shadow-menu"
    >
      <span className={problem ? 'text-danger' : 'text-secondary'}>{text}</span>
      <Button variant="ghost" size="compact" onClick={onDismiss}>
        {t('edit.dismiss')}
      </Button>
    </div>
  )
}
