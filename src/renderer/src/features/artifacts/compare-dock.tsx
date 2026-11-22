import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { DockRule } from './viewer-shell'

/** A piece an agent's version changed, compared in place with the version before. */
export interface CompareSwitch {
  /** The version before the agent's, and the agent's. */
  from: number
  to: number
  /** The version before shows. */
  showingBefore: boolean
  onChange: (before: boolean) => void
}

/** "v18 | v19" in the dock: the piece as it was before the agent's version, or after it. */
export function CompareDock({ compare }: { compare: CompareSwitch }) {
  const { t } = useTranslation('artifacts')
  return (
    <>
      <DockRule />
      <SegmentedControl<'before' | 'after'>
        aria-label={t('compare.label')}
        variant="tray"
        size="sm"
        className="k-vt-compare"
        value={compare.showingBefore ? 'before' : 'after'}
        onChange={(side) => compare.onChange(side === 'before')}
        options={[
          { value: 'before', label: t('viewer.version', { version: compare.from }) },
          { value: 'after', label: t('viewer.version', { version: compare.to }) },
        ]}
      />
    </>
  )
}
