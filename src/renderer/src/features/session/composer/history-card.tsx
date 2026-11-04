import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InputHistoryEntry } from './use-input-history'

/** The card over the composer that shows the sent message the arrows are browsing. */
export function HistoryCard({
  entry,
  onInsert,
}: {
  entry: InputHistoryEntry
  onInsert: () => void
}) {
  const { t } = useTranslation('composer')
  return (
    <div className="mb-2.5 animate-in overflow-hidden rounded-card bg-surface shadow-card fade-in animation-duration-(--duration-base) motion-reduce:animate-none">
      <p className="px-4 pt-3.5 pb-2 text-hint text-tertiary">
        {t('history.label')}{' '}
        <span className="tabular">
          {entry.index}/{entry.count}
        </span>
      </p>
      {/* Pressing the row keeps the focus, and with it the caret, in the box. */}
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onInsert}
        className="mx-1.5 mb-1.5 flex items-center gap-3.5 rounded-tile px-2.5 py-2 text-left outline-none hover:bg-selected focus-visible:focus-ring"
      >
        <PlusIcon aria-hidden strokeWidth={1.5} className="size-3.75 shrink-0 text-icon" />
        <span className="min-w-0 flex-1 truncate text-subheading">{entry.text}</span>
      </button>
    </div>
  )
}
