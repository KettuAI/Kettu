import { ArrowDown01Icon, ComputerIcon, ServerStack02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { isAway, useHostsStore, useOtherHosts } from '@renderer/stores/hosts'
import { openHostSettings } from './host-sections'

/**
 * The host whose sections the list's lower part shows: this computer or another host it connects
 * to. One away cannot be reached, so it is listed but cannot be chosen.
 */
export function HostPicker({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation('settings')
  const hosts = useOtherHosts()
  const self = useHostsStore((s) => s.status?.self.name ?? null)
  const selfLabel = self ? t('hostPicker.self', { name: self }) : t('hostPicker.selfUnnamed')
  const chosen = hostId === null ? null : hosts.find((host) => host.id === hostId)
  return (
    <div className="kettu-settings__scope">
      <span className="ui-as-side__label">{t('hostPicker.label')}</span>
      <Dropdown
        items={[
          {
            label: selfLabel,
            checked: hostId === null,
            onSelect: () => openHostSettings(null),
          },
          ...hosts.map((host) => {
            const away = isAway(host.connection)
            return {
              label: host.name,
              description: away ? t('hostPicker.offline') : undefined,
              checked: host.id === hostId,
              disabled: away,
              onSelect: () => openHostSettings(host.id),
            }
          }),
        ]}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="ui-ss-select k-select"
            aria-label={t('hostPicker.label')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <span className="k-select__lead">
              <Icon icon={hostId === null ? ComputerIcon : ServerStack02Icon} size={14} />
            </span>
            <span className="k-select__value">
              {chosen ? chosen.name : t('hostPicker.selfUnnamed')}
            </span>
            <Icon icon={ArrowDown01Icon} size={14} />
          </button>
        )}
      />
    </div>
  )
}
