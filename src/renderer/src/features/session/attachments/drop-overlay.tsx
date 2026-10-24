import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'

/** Says what a drop does while files are dragged over the column; it never takes the pointer. */
export function DropOverlay({
  shown,
  starting,
  agentName,
}: {
  shown: boolean
  starting: boolean
  agentName: string
}) {
  const { t } = useTranslation('composer')
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-30 grid place-items-center bg-app/88 transition-opacity duration-(--duration-fast) ease-out-quart',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className="rounded-2xl bg-surface px-7 py-5 text-center shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]">
        <div className="text-heading font-medium text-primary">
          {starting
            ? t('attachments.waitForAgent', { agent: agentName })
            : t('attachments.dropTitle')}
        </div>
        {!starting && <div className="text-xs text-tertiary">{t('attachments.dropHint')}</div>}
      </div>
    </div>
  )
}
