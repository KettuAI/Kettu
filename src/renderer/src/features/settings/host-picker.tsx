import { useId } from 'react'
import { ServerIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { isAway, useHostsStore, useOtherHosts } from '@renderer/stores/hosts'
import { openHostSettings } from './host-sections'

const THIS_COMPUTER = 'self'

/**
 * The host whose sections the list's lower part shows: this computer or another host it connects
 * to. One away cannot be reached, so it is listed but cannot be chosen.
 */
export function HostPicker({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation('settings')
  const label = useId()
  const hosts = useOtherHosts()
  const self = useHostsStore((s) => s.status?.self.name ?? null)
  const selfLabel = self ? t('hostPicker.self', { name: self }) : t('hostPicker.selfUnnamed')
  const options = [
    { value: THIS_COMPUTER, label: selfLabel, away: false },
    ...hosts.map((host) => ({ value: host.id, label: host.name, away: isAway(host.connection) })),
  ]
  return (
    <div className="flex flex-col gap-1 px-0.5">
      <div id={label} className="px-2 text-xs text-tertiary">
        {t('hostPicker.label')}
      </div>
      <Select
        value={hostId ?? THIS_COMPUTER}
        items={options}
        onValueChange={(next) => {
          if (next === null) return
          openHostSettings(next === THIS_COMPUTER ? null : (next as string))
        }}
      >
        <SelectTrigger aria-labelledby={label} className="h-row w-full text-ui">
          <ServerIcon className="size-3.5 text-icon" />
          <SelectValue className="min-w-0 flex-1 truncate">
            {(current: string) => options.find((o) => o.value === current)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.away}
                className="data-disabled:text-tertiary data-disabled:opacity-100"
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {option.away && (
                  <span className="text-xs text-tertiary">{t('hostPicker.offline')}</span>
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
