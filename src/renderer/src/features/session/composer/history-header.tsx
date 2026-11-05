import { useTranslation } from 'react-i18next'
import type { InputHistoryPosition } from './use-input-history'

/** The row on the box's upper edge that says its text is a sent message the arrows are browsing. */
export function HistoryHeader({ position }: { position: InputHistoryPosition }) {
  const { t } = useTranslation('composer')
  return (
    <p className="w-full animate-in pb-0.5 text-hint text-tertiary fade-in animation-duration-(--duration-fast) motion-reduce:animate-none">
      {t('history.label')}{' '}
      <span className="tabular">
        {position.index}/{position.count}
      </span>
    </p>
  )
}
