import { useState, type ReactNode } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'
import { splitName, type SelectOption } from './levels'
import { CheckColumn, DESCRIBED_ROW, ItemText } from './menu-parts'
import { shownChoice } from './model-list'
import { MODE_GLYPH } from './modes'
import { useSelectPick, type Select } from './use-pick'

function choiceName(option: SelectOption, value: string | undefined): string {
  return shownChoice(option.choices, value)?.name ?? String(value)
}

function AsksIcon({ className }: ModeIconProps) {
  return <Glyph icon={MODE_GLYPH.asks} className={className} />
}
function EditsIcon({ className }: ModeIconProps) {
  return <Glyph icon={MODE_GLYPH.edits} className={className} />
}
function PlanIcon({ className }: ModeIconProps) {
  return <Glyph icon={MODE_GLYPH.plan} className={className} />
}
function AutoIcon({ className }: ModeIconProps) {
  return <Glyph icon={MODE_GLYPH.auto} className={className} />
}
function FullIcon({ className }: ModeIconProps) {
  return <Glyph icon={MODE_GLYPH.full} className={className} />
}

type ModeIconProps = { className?: string; 'aria-hidden'?: boolean }

/** Each permission mode's icon, for a surface that draws the modes itself. */
export const MODE_ICON = {
  asks: AsksIcon,
  edits: EditsIcon,
  plan: PlanIcon,
  auto: AutoIcon,
  full: FullIcon,
}

/**
 * A menu for an option other than the mode, model and effort, which closes once a choice is made.
 * Its button is one of the composer's quiet controls.
 */
export function OptionMenu({
  option,
  onSelect,
  side = 'top',
  align = 'start',
}: {
  option: SelectOption
  onSelect: Select
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}) {
  const { t } = useTranslation('composer')
  const [value, pick] = useSelectPick(option, onSelect)
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('controls.optionValue', {
              name: option.name,
              value: choiceName(option, value),
            })}
            className="ui-ccc__approval kettu-option"
          />
        }
      >
        <span className="ui-ccc__approval-text">{choiceName(option, value)}</span>
        <Glyph icon={ArrowDown01Icon} size={14} className="kettu-option__chevron" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        sideOffset={8}
        aria-label={option.name}
        className="w-64"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => pick(String(v))}>
            {option.choices.map((choice) => (
              <CheckRow key={choice.value} value={choice.value} described={!!choice.description}>
                <ItemText
                  name={<ChoiceName name={choice.name} className="font-normal" />}
                  description={choice.description}
                />
              </CheckRow>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A choice with its check in a column that leads the row. */
function CheckRow({
  value,
  described = false,
  children,
}: {
  value: string
  described?: boolean
  children: ReactNode
}) {
  return (
    <DropdownMenuRadioItem
      value={value}
      closeOnClick
      className={cn(
        'pr-2 *:data-[slot=dropdown-menu-radio-item-indicator]:hidden',
        described && DESCRIBED_ROW,
      )}
    >
      <CheckColumn>
        <MenuPrimitive.RadioItemIndicator className="flex">
          <Glyph icon={Tick02Icon} size={14} />
        </MenuPrimitive.RadioItemIndicator>
      </CheckColumn>
      {children}
    </DropdownMenuRadioItem>
  )
}

export function ChoiceName({
  name,
  prefix: givenPrefix,
  className,
}: {
  name: string
  /** Optional provider prefix already split from `name` by `splitChoiceName`. */
  prefix?: string
  className?: string
}) {
  const [prefix, rest] = givenPrefix !== undefined ? [givenPrefix, name] : splitName(name)
  return (
    <span className={cn('block min-w-0 truncate font-medium', className)}>
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      {rest}
    </span>
  )
}
