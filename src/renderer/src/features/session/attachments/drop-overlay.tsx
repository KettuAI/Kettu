import { Download04Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { ATTACHMENT_LIMIT } from '@shared/attachments'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'

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
        'pointer-events-none absolute inset-0 z-30 bg-card p-4.5 transition-opacity duration-(--duration-fast) ease-out-quart',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        className={cn(
          'flex size-full flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed text-center',
          starting
            ? 'border-border-strong text-secondary'
            : 'border-control-on bg-control-on/6 text-control-on',
        )}
      >
        <Glyph icon={Download04Icon} className="size-5" />
        <div className="text-ui font-medium">
          {starting
            ? t('attachments.waitForAgent', { agent: agentName })
            : t('attachments.dropTitle')}
        </div>
        {!starting && (
          <div className="text-small text-tertiary">
            {t('attachments.dropHint', { count: ATTACHMENT_LIMIT })}
          </div>
        )}
      </div>
    </div>
  )
}
