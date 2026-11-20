import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SetButton, SettingSwitch } from './controls'
import { useIslandState } from './island-state'
import { useApply } from './use-apply'

/** The notch island's switch, with Try again once it stopped after crashing. */
export function IslandSwitch({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const checked = useHostScope().useSettingsStore((s) => s.settings.notifications.island)
  const state = useIslandState()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      {checked && state.state === 'failed' && state.reason === 'crashed' && (
        <SetButton size="sm" onClick={() => void window.kettu.island.retry()}>
          {t('notifications.island.retry')}
        </SetButton>
      )}
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ notifications: { island: v } })}
      />
    </>
  )
}
