import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { APP_ICONS, normalizeAppIcon, type AppIcon } from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import { appIconUrl } from '@renderer/lib/app-icons'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError } from './controls'
import { useApply } from './use-apply'

/** Six selectable app icon tiles for Settings > Appearance; hidden in the web client. */
export function AppIconTiles() {
  const { t } = useTranslation('settings')
  const stored = useHostScope().useSettingsStore((s) => s.settings.appearance.appIcon)
  const [apply, applyError] = useApply()
  if (isWeb) return null
  const chosen: AppIcon = normalizeAppIcon(stored) ?? 'kettu'

  return (
    <div className="k-app-icons-wrap">
      <ToggleGroup
        aria-label={t('appearance.appIcon.name')}
        value={[chosen]}
        onValueChange={(next) => {
          const picked = normalizeAppIcon(next[0])
          if (picked && picked !== chosen) apply({ appearance: { appIcon: picked } })
        }}
        className="k-app-icons"
      >
        {APP_ICONS.map((id) => {
          const selected = id === chosen
          const label = t(`appearance.appIcon.options.${id}`)
          return (
            <Toggle key={id} value={id} data-app-icon={id} className="k-app-icon">
              <span className="k-app-icon__preview" aria-hidden>
                <img src={appIconUrl(id)} alt="" width={56} height={56} draggable={false} />
              </span>
              <span className="k-app-icon__name">
                {selected && (
                  <span className="k-app-icon__check" aria-hidden>
                    <Icon icon={Tick02Icon} size={13} />
                  </span>
                )}
                <b>{label}</b>
              </span>
            </Toggle>
          )
        })}
      </ToggleGroup>
      <ControlError error={applyError} />
    </div>
  )
}
