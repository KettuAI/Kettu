import { memo } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { duration } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { workCounts } from '../turn-work'

/**
 * A finished turn's work folded into one row under its message: how long the turn took and how
 * many files it read and edited. It opens to show the turn as it was.
 */
export const WorkedRow = memo(function WorkedRow({
  sessionId,
  rowKey,
  toolIds,
  endId,
  open,
  onToggle,
}: {
  sessionId: string
  rowKey: string
  toolIds: string[]
  endId: string | null
  open: boolean
  onToggle: (key: string) => void
}) {
  const { t } = useTranslation('session')
  const counts = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return workCounts(toolIds.map((id) => byId?.[id]))
    }),
  )
  const took = useThreadsStore((s) => {
    const end = endId ? s.replicas[sessionId]?.state?.byId[endId] : undefined
    return end?.kind === 'turn_end' ? end.durationMs : null
  })
  const read = counts.reads > 0 ? t('worked.read', { count: counts.reads }) : null
  const edited =
    counts.edits > 0
      ? t(read ? 'worked.editedAfter' : 'worked.edited', { count: counts.edits })
      : null
  const work = read && edited ? t('worked.both', { read, edited }) : (read ?? edited)
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onToggle(rowKey)}
      className="group/worked -ml-2 flex min-h-7 max-w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-tile px-2 text-left text-control text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
    >
      <ChevronRightIcon
        aria-hidden
        strokeWidth={1.75}
        className={cn(
          'size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
          open && 'rotate-90',
        )}
      />
      <span className="min-w-0 truncate tabular">
        {took === null ? t('worked.untimed') : t('worked.for', { duration: duration(took) })}
      </span>
      {work && (
        <>
          <span aria-hidden className="text-(--border-strong)">
            {t('summary.separator')}
          </span>
          <span className="min-w-0 truncate">{work}</span>
        </>
      )}
    </button>
  )
})
