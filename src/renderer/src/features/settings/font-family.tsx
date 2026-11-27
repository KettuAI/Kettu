// A face installed on this computer, picked from a searchable menu: the terminal's, and the
// interface's, replies' and code's in Appearance (each with an optional Chinese font). Where the
// window cannot list fonts, a name typed into the search is used as it is.

import { useRef, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { fontStack, userFontStack } from '@shared/font-stack'
import {
  cjkFontKey,
  isFontFamilyName,
  USER_FONT_ROLES,
  type UserFontKey,
  type UserFontRole,
} from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { listInstalledFonts, type FontList } from '@renderer/features/terminal/local-fonts'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError } from './controls'
import { FlashMark, RowGroup, RowShell, RowText } from './rows'
import { useApply } from './use-apply'

// Rows are drawn a page at a time, more as the list scrolls: hundreds of rows at once block the
// window on their own.
const PAGE = 50

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

const ROLE_THEME_FALLBACK: Record<UserFontRole, string> = {
  ui: 'var(--theme-ui-face)',
  prose: 'var(--theme-prose-face)',
  code: 'var(--theme-code-face)',
}

/**
 * Settings › Appearance › Fonts: primary and optional Chinese pickers for interface, replies and
 * code, followed by a live mixed Latin/digits/code/Chinese preview.
 */
export function FontsCard() {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const fonts = useSettingsStore((s) => s.settings.appearance.fonts)

  return (
    <RowGroup>
      {USER_FONT_ROLES.map((role) => (
        <UserFontRoleRow key={role} role={role} />
      ))}
      <RowShell>
        <div className="k-font-preview-row">
          <span aria-hidden className="k-preview-label">
            {t('appearance.fonts.previewLabel')}
          </span>
          <div aria-hidden className="k-inset k-font-preview" data-testid="font-preview">
            {USER_FONT_ROLES.map((role) => (
              <div
                key={role}
                className={`k-font-preview__line k-font-preview__line--${role}`}
                data-font-preview-role={role}
              >
                <span className="k-font-preview__tag">
                  {t(`appearance.fonts.preview.${role}Label`)}
                </span>
                <span
                  className="k-font-preview__sample"
                  style={{ fontFamily: userFontStack(role, fonts) ?? ROLE_THEME_FALLBACK[role] }}
                >
                  {t(`appearance.fonts.preview.${role}`)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </RowShell>
    </RowGroup>
  )
}

function UserFontRoleRow({ role }: { role: UserFontRole }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const fonts = useSettingsStore((s) => s.settings.appearance.fonts)
  const [apply, error] = useApply()
  const cjkKey = cjkFontKey(role)
  const primary = fonts[role] ?? null
  const cjk = fonts[cjkKey] ?? null
  const primaryName = t(`appearance.fonts.${role}.name`)
  const cjkName = t(`appearance.fonts.${role}.cjkName`)

  const updateFont = (key: UserFontKey, id: string | null) => {
    const next = { ...fonts }
    if (id === null) delete next[key]
    else next[key] = id
    apply({ appearance: { fonts: next } })
  }

  return (
    <RowShell id={`font-${role}`}>
      <div className="k-block k-font-role">
        <div className="k-font-role__head">
          <RowText name={primaryName} description={t(`appearance.fonts.${role}.description`)} />
          <ControlError error={error} />
        </div>
        <div className="k-font-pair">
          <div className="k-field k-font-field">
            <span className="k-font-field__head">
              <span>{t('appearance.fonts.primaryLabel')}</span>
              {primary && (
                <button
                  type="button"
                  className="k-font-clear"
                  aria-label={t('appearance.fonts.resetPrimary', { role: primaryName })}
                  onClick={() => updateFont(role, null)}
                >
                  {t('appearance.fonts.reset')}
                </button>
              )}
            </span>
            <FontPicker
              label={primaryName}
              family={primary}
              defaultLabel={t('appearance.fonts.default')}
              monospace={role === 'code'}
              fallback={ROLE_FALLBACK[role]}
              triggerClassName="k-select--full"
              error={null}
              onPick={(id) => updateFont(role, id)}
            />
          </div>
          <div data-setting-row={`font-${role}-cjk`} className="k-row k-field k-font-field">
            <FlashMark id={`font-${role}-cjk`} />
            <span className="k-font-field__head">
              <span>{t('appearance.fonts.cjkLabel')}</span>
              {cjk && (
                <button
                  type="button"
                  className="k-font-clear"
                  aria-label={t('appearance.fonts.resetCjk', { role: cjkName })}
                  onClick={() => updateFont(cjkKey, null)}
                >
                  {t('appearance.fonts.reset')}
                </button>
              )}
            </span>
            <FontPicker
              label={cjkName}
              family={cjk}
              defaultLabel={t('appearance.fonts.cjkDefault')}
              monospace={false}
              fallback={ROLE_FALLBACK[role]}
              sample={t('appearance.fonts.cjkSample')}
              triggerClassName="k-select--full"
              error={null}
              onPick={(id) => updateFont(cjkKey, id)}
            />
          </div>
        </div>
      </div>
    </RowShell>
  )
}

function FontPicker({
  label,
  family,
  defaultLabel,
  monospace,
  fallback,
  sample,
  triggerClassName,
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
  /** Optional short sample shown on the right of each menu item (e.g. CJK characters). */
  sample?: string
  triggerClassName?: string
  error: string | null
  onPick(id: string | null): void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [drawn, setDrawn] = useState(PAGE)
  const [fonts, setFonts] = useState<FontList | null>(null)
  const asked = useRef(false)

  // Listed when the menu first opens: the browser's prompt, if any, answers a click.
  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setQuery('')
      setDrawn(PAGE)
    } else if (!asked.current) {
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
  // The menu opens scrolled to the chosen face, so its row is always drawn.
  const limit = Math.max(drawn, choices.findIndex((choice) => choice.id === chosen.id) + PAGE)
  const rows = choices.slice(0, limit)

  return (
    <>
      <ControlError error={error} />
      <Combobox<FontChoice>
        items={rows}
        filteredItems={rows}
        value={chosen}
        open={open}
        onOpenChange={onOpenChange}
        inputValue={query}
        onInputValueChange={(value) => {
          setQuery(value)
          setDrawn(PAGE)
        }}
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
              className={cn('ui-ss-select k-select', triggerClassName ?? 'k-select--wide')}
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
          <ComboboxList
            className="max-h-72 px-1.5 pt-0.5 pb-1.5"
            onScroll={(event) => {
              const list = event.currentTarget
              const ahead = list.scrollHeight - list.scrollTop - list.clientHeight
              if (limit < choices.length && ahead < list.clientHeight) setDrawn(limit + PAGE)
            }}
          >
            {(choice: FontChoice) => {
              const previewStyle =
                choice.id && !choice.custom
                  ? { fontFamily: fontStack(choice.id, fallback) }
                  : undefined
              return (
                <ComboboxItem
                  key={choice.id ?? ''}
                  value={choice}
                  className="h-9 gap-2.5 rounded-lg py-1 pr-8 pl-2 [content-visibility:auto]"
                >
                  <span className="truncate text-menu text-primary" style={previewStyle}>
                    {choice.label}
                  </span>
                  {sample && previewStyle && (
                    <span
                      aria-hidden
                      className="ml-auto shrink-0 text-small text-tertiary"
                      style={previewStyle}
                    >
                      {sample}
                    </span>
                  )}
                </ComboboxItem>
              )
            }}
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
