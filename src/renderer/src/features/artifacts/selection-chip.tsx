import { Cancel01Icon, Cursor01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { PaneSelection } from '@renderer/stores/artifacts'
import { anchorLabel } from './anchors'

/** What is picked in the artifact beside the thread, above the composer's text, until removed. */
export function SelectionChip({
  selection,
  onRemove,
}: {
  selection: PaneSelection
  onRemove: () => void
}) {
  const { t } = useTranslation('artifacts')
  const label = t('selection.label', {
    title: selection.title,
    anchor: anchorLabel(selection.anchor),
  })
  return (
    <div className="flex w-full min-w-0 animate-in pb-0.5 fade-in animation-duration-(--duration-fast)">
      <span className="flex h-6.5 min-w-0 items-center gap-1.5 rounded-lg bg-subtle pr-0.5 pl-2 text-small text-secondary">
        <HugeiconsIcon
          aria-hidden
          icon={Cursor01Icon}
          strokeWidth={1.9}
          className="size-3.25 shrink-0 text-tertiary"
        />
        <span className="min-w-0 truncate">{label}</span>
        <button
          type="button"
          aria-label={t('selection.remove', { label })}
          onClick={onRemove}
          className="flex size-5.5 shrink-0 items-center justify-center rounded-md text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring"
        >
          <HugeiconsIcon aria-hidden icon={Cancel01Icon} strokeWidth={1.9} className="size-3.5" />
        </button>
      </span>
    </div>
  )
}
