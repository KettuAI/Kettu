import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { booleanConfigValue, type ConfigOption } from '@shared/thread'
import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { DESCRIBED_ROW, ItemText } from './menu-parts'

/** Whether the agent's own setting can stand for the option's value. */
function inheritsSetting(option: ConfigOption): boolean {
  return 'defaultValue' in option
}

/** Whether the option has no value of its own and follows the agent's setting. */
function followsSetting(option: ConfigOption): boolean {
  return inheritsSetting(option) && option.value === 'default'
}

/** The value a press on the switch sends: the opposite of the value the agent reports. */
function toggledValue(option: ConfigOption): boolean {
  return booleanConfigValue(option) !== true
}

/** The line that says a value follows the agent, with on or off only when the agent reports one. */
function SettingText({ option }: { option: ConfigOption }) {
  const { t } = useTranslation('composer')
  const value = booleanConfigValue(option)
  return value === true
    ? t('controls.followsAgentOn')
    : value === false
      ? t('controls.followsAgentOff')
      : t('controls.followsAgent')
}

/**
 * A boolean option as a row: a menu item that keeps the menu open, or a list row. The switch shows
 * the value in effect; an inherited one says so.
 */
export function ConfigSwitchRow({
  option,
  icon,
  disabled = false,
  menu = false,
  onSelect,
}: {
  option: ConfigOption
  icon?: ReactNode
  disabled?: boolean
  menu?: boolean
  onSelect: (value: boolean) => void
}) {
  const { t } = useTranslation('composer')
  const id = useId()
  const checked = booleanConfigValue(option) === true
  const follows = followsSetting(option)
  const said = disabled ? (
    t('controls.changesBetweenTurns')
  ) : follows ? (
    <SettingText option={option} />
  ) : (
    option.description
  )

  if (menu) {
    return (
      <DropdownMenuItem
        closeOnClick={false}
        role="menuitemcheckbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onSelect(toggledValue(option))}
        className={cn(said && DESCRIBED_ROW)}
      >
        {icon}
        <ItemText name={option.name} description={said} />
        <Switch
          size="sm"
          checked={checked}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none ml-3"
        />
      </DropdownMenuItem>
    )
  }

  return (
    <div className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1.25 text-ui hover:bg-hover">
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-default flex-col">
        <span>{option.name}</span>
        {said && <span className="text-xs text-muted-foreground">{said}</span>}
      </label>
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(on) => onSelect(on)}
      />
    </div>
  )
}
