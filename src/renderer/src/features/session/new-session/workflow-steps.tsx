import { useTranslation } from 'react-i18next'
import { PACES, type Pace } from '@shared/workflow'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'

/** Quick, Balanced or Thorough: told to every agent that picks who does a step. */
export function PaceControl({
  value,
  onChange,
  disabled = false,
}: {
  value: Pace
  onChange: (pace: Pace) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('session')
  return (
    <SegmentedControl<Pace>
      aria-label={t('workflow.pace')}
      variant="tray"
      size="sm"
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={PACES.map((pace) => ({ value: pace, label: t(`workflow.paces.${pace}`) }))}
    />
  )
}
