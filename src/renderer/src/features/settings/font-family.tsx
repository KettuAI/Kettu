// A face installed on this computer, picked from a searchable menu: the terminal's, and the
// interface's, replies' and code's in Appearance. Where the window cannot list fonts, a name typed
// into the search is used as it is.

import { useRef, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isFontFamilyName, type UserFontRole } from '@shared/settings'
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

/** A face in the menu; `id` null is the default face, `custom` a name typed in the search. */
interface FontChoice {
  id: string | null
  label: string
  custom?: boolean
}

/** The terminal's face, over the code font. */
export function FontFamily({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const family = useSettingsStore((s) => s.settings.terminal.fontFamily) ?? null
  const [apply, error] = useApply()
  return (
    <FontPicker
      label={label}
      family={family}
      defaultLabel={t('terminal.fontFamily.default')}
      monospace
      fallback="var(--font-mono)"
      error={error}
      onPick={(id) => apply({ terminal: { fontFamily: id } })}
    />
  )
}

const ROLE_FALLBACK: Record<UserFontRole, string> = {
  ui: 'var(--font-sans)',
  prose: 'var(--font-prose)',
  code: 'var(--font-mono)',
}

/** The face of the interface, replies or code, over the theme's. */
export function UserFont({ role, label }: { role: UserFontRole; label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const fonts = useSettingsStore((s) => s.settings.appearance.fonts)
  const [apply, error] = useApply()
  return (
    <FontPicker
      label={label}
      family={fonts[role] ?? null}
      defaultLabel={t('appearance.fonts.default')}
      monospace={role === 'code'}
      fallback={ROLE_FALLBACK[role]}
      error={error}
      onPick={(id) => {
        const next = { ...fonts }
        if (id === null) delete next[role]
        else next[role] = id
        apply({ appearance: { fonts: next } })
      }}
    />
  )
}

function FontPicker({
  label,
  family,
  defaultLabel,
  monospace,
  fallback,
  error,
  onPick,
}: {
  label: string
  family: string | null
  defaultLabel: string
  /** Lists only monospace faces, though any typed name is still taken. */
  monospace: boolean
  /** The stack each face is drawn over in the menu. */
  fallback: string
  error: string | null
  onPick(id: string | null): void
}) {
  const { t } = useTranslation('settings')
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
      void listInstalledFonts(monospace).then(setFonts)
    }
  }

  const defaultChoice: FontChoice = { id: null, label: defaultLabel }
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
      ? [{ id: typed, label: t('fonts.use', { name: typed }), custom: true }]
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
          if (choice && choice.id !== family) onPick(choice.id)
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
            placeholder={t('fonts.search')}
            aria-label={t('fonts.search')}
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
                      ? { fontFamily: terminalFontStack(choice.id, fallback) }
                      : undefined
                  }
                >
                  {choice.label}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{t(monospace ? 'fonts.noMonospaceMatch' : 'fonts.noMatch')}</ComboboxEmpty>
          {fonts === null && open && (
            <p role="status" className="px-3.5 pb-2 text-small text-tertiary">
              {t('fonts.loading')}
            </p>
          )}
          {fonts?.state === 'unavailable' && (
            <p role="status" className="px-3.5 pb-2 text-small text-tertiary">
              {t('fonts.unavailable')}
            </p>
          )}
        </ComboboxContent>
      </Combobox>
    </>
  )
}
