import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import type { LimitView } from '@renderer/lib/plan-limit'
import { useSettingsStore } from '@renderer/stores/settings'

/** The switch between Used and Left that every plan limit follows, kept in the settings. */
export function LimitViewSwitch({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const view = useLimitView()
  return (
    <SegmentedControl<LimitView>
      aria-label={t('planView.label')}
      variant="tray"
      size="sm"
      value={view}
      onChange={(limits) => void useSettingsStore.getState().update({ usage: { limits } })}
      options={[
        { value: 'used', label: t('planView.used') },
        { value: 'left', label: t('planView.left') },
      ]}
      className={className}
    />
  )
}
