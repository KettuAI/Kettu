// The terminal's font: one face installed on this computer, picked from a searchable menu. Where
// the window cannot list fonts, a name typed into the search is used as it is.

import { useRef, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isFontFamilyName } from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { terminalFontStack } from '@renderer/features/terminal/font-stack'
import { listInstalledFonts, type FontList } from '@renderer/features/terminal/local-fonts'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError } from './controls'
import { useApply } from './use-apply'

/** A face in the menu; `id` null is the theme's code font, `custom` a name typed in the search. */
interface FontChoice {
  id: string | null
  label: string
  custom?: boolean
}

export function FontFamily({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const family = useSettingsStore((s) => s.settings.terminal.fontFamily) ?? null
  const [apply, error] = useApply()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [fonts, setFonts] = useState<FontList | null>(null)
  const asked = useRef(false)

  // Listed when the menu first opens: the browser's prompt, if any, answers a click.
  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) setQuery('')
    else if (!asked.current) {
      asked.current = true
      void listInstalledFonts().then(setFonts)
    }
  }

  const defaultChoice: FontChoice = { id: null, label: t('terminal.fontFamily.default') }
  const names = new Set(fonts?.state === 'ready' ? fonts.families : [])
  // A face chosen before and no longer listed stays in the menu, so it can be seen and kept.
  if (family) names.add(family)
  const installed: FontChoice[] = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, label: name }))
  const typed = query.trim()
  const needle = typed.toLowerCase()
  const matches = typed
    ? installed.filter((choice) => choice.label.toLowerCase().includes(needle))
    : [defaultChoice, ...installed]
  // A typed name no listed face matches is offered as it is: a face the list left out, or none
  // listed at all.
  const choices =
    typed && matches.length === 0 && isFontFamilyName(typed)
      ? [{ id: typed, label: t('terminal.fontFamily.use', { name: typed }), custom: true }]
      : matches
  const chosen = family ? { id: family, label: family } : defaultChoice

  return (
    <>
      <ControlError error={error} />
      <Combobox<FontChoice>
        items={choices}
        filteredItems={choices}
        value={chosen}
        open={open}
        onOpenChange={onOpenChange}
        inputValue={query}
        onInputValueChange={setQuery}
        onValueChange={(choice) => {
          if (choice && choice.id !== family) apply({ terminal: { fontFamily: choice.id } })
        }}
        itemToStringLabel={(choice) => choice.label}
        isItemEqualToValue={(a, b) => a.id === b.id}
        autoHighlight
      >
        <ComboboxPrimitive.Trigger
          render={
            <button
              type="button"
              className="ui-ss-select k-select k-select--wide"
              aria-label={label}
            />
          }
        >
          <span className="k-select__value">{chosen.label}</span>
          <Icon icon={ArrowDown01Icon} size={14} />
        </ComboboxPrimitive.Trigger>
        <ComboboxContent align="end" sideOffset={6} className="flex w-72 flex-col">
          <ComboboxInput
            showTrigger={false}
            placeholder={t('terminal.fontFamily.search')}
            aria-label={t('terminal.fontFamily.search')}
            spellCheck={false}
            className="h-10.5! px-2"
          />
          <ComboboxList className="max-h-72 px-1.5 pt-0.5 pb-1.5">
            {(choice: FontChoice) => (
              <ComboboxItem
                key={choice.id ?? ''}
                value={choice}
                className="h-9 gap-2.5 rounded-lg py-1 pr-8 pl-2 data-highlighted:bg-hover"
              >
                <span
                  className="truncate text-menu text-primary"
                  style={
                    choice.id && !choice.custom
                      ? { fontFamily: terminalFontStack(choice.id, 'var(--font-mono)') }
                      : undefined
                  }
                >
                  {choice.label}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{t('terminal.fontFamily.noMatch')}</ComboboxEmpty>
          {fonts === null && open && (
            <p role="status" className="px-3.5 pb-2 text-small text-tertiary">
              {t('terminal.fontFamily.loading')}
            </p>
          )}
          {fonts?.state === 'unavailable' && (
            <p role="status" className="px-3.5 pb-2 text-small text-tertiary">
              {t('terminal.fontFamily.unavailable')}
            </p>
          )}
        </ComboboxContent>
      </Combobox>
    </>
  )
}
