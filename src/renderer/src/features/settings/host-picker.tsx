import { useId } from 'react'
import { LaptopIcon, ServerIcon } from 'lucide-react'
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
    <div className="mx-0.5 mt-3.5 mb-1.5 flex flex-col px-2 pt-2.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
      <div id={label} className="mb-1.5 text-caption leading-[normal] font-medium text-tertiary">
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
        <SelectTrigger
          aria-labelledby={label}
          className="h-row w-full gap-2 rounded-xl bg-subtle pr-2 pl-2.5 text-control text-primary shadow-none hover:bg-selected [&>svg:last-child]:stroke-[1.75] [&>svg:last-child]:text-tertiary"
        >
          {hostId === null ? (
            <LaptopIcon className="size-3.75 text-secondary" />
          ) : (
            <ServerIcon className="size-3.75 text-secondary" />
          )}
          <SelectValue className="min-w-0 flex-1 truncate">
            {(current: string) =>
              current === THIS_COMPUTER
                ? t('hostPicker.selfUnnamed')
                : options.find((o) => o.value === current)?.label
            }
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
