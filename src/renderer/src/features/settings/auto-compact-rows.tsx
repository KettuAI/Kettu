// When an agent's harness compacts on its own, on its page: a value for all models and, for a
// harness that sets one per model, a row per model, each picked from steps or typed in, in the
// unit the harness's own setting takes.

import { useCallback, useEffect, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, AutoCompactRow, AutoCompactSettings } from '@shared/agent-host'
import { canonicalClaudeModel, KNOWN_CLAUDE_MODELS } from '@shared/agents'
import {
  compactLabel,
  compactSteps,
  inCompactRange,
  parseCompactValue,
  type CompactSpec,
} from '@shared/auto-compact'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { Skel } from './controls'
import { BlockLine, RowShell, RowText } from './rows'

const MAX_MODEL_CHARS = 256

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: AutoCompactSettings }

/** One entry of a value's dropdown: Auto, a step, the file's own value or what was typed. */
interface ValueChoice {
  key: string
  label: string
  /** Null for Auto, which removes the key; undefined for an entry that writes nothing. */
  value: number | null | undefined
  disabled?: boolean
}

const AUTO_KEY = 'auto'

function ValuePicker({
  spec,
  value,
  other,
  auto,
  label,
  disabled,
  onChange,
}: {
  spec: CompactSpec
  value: number | null
  other: string | null
  auto: string
  label: string
  disabled: boolean
  onChange: (value: number | null) => void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const valueKey = (tokens: number): string => `v${tokens}`
  const steps = compactSteps(spec)
  const shown =
    value !== null && !steps.includes(value) ? [...steps, value].sort((a, b) => a - b) : steps
  const choices: ValueChoice[] = [
    { key: AUTO_KEY, label: auto, value: null },
    ...shown.map((tokens) => ({
      key: valueKey(tokens),
      label: compactLabel(spec.unit, tokens),
      value: tokens,
    })),
  ]
  if (other !== null) choices.push({ key: 'other', label: other, value: undefined, disabled: true })
  const current =
    other !== null
      ? choices.find((choice) => choice.key === 'other')!
      : (choices.find((choice) => choice.key === (value === null ? AUTO_KEY : valueKey(value))) ??
        choices[0]!)

  const text = query.trim()
  const typed = text === '' ? null : parseCompactValue(spec.unit, text)
  const range = t('agents.autoCompact.range', {
    min: compactLabel(spec.unit, spec.min),
    max: compactLabel(spec.unit, spec.max),
  })
  const items: ValueChoice[] =
    text === ''
      ? choices
      : typed !== null && inCompactRange(spec, typed)
        ? [
            {
              key: `typed${typed}`,
              label: t('agents.autoCompact.use', { value: compactLabel(spec.unit, typed) }),
              value: typed,
            },
          ]
        : [{ key: 'invalid', label: range, value: undefined, disabled: true }]

  return (
    <Combobox<ValueChoice>
      items={items}
      filteredItems={items}
      value={current}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(choice) => {
        if (!choice || choice.value === undefined) return
        setOpen(false)
        if (choice.value !== value || other !== null) onChange(choice.value)
      }}
      itemToStringLabel={(choice) => choice.label}
      isItemEqualToValue={(a, b) =>
        a.key === b.key || (a.value !== undefined && a.value === b.value)
      }
      autoHighlight
    >
      <ComboboxPrimitive.Trigger
        render={
          <button
            type="button"
            className="ui-ss-select k-select"
            aria-label={label}
            disabled={disabled}
          />
        }
      >
        <span className="k-select__value">{current.label}</span>
        <Icon icon={ArrowDown01Icon} size={14} />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent align="end" sideOffset={6} className="flex w-64 flex-col">
        <ComboboxInput
          showTrigger={false}
          placeholder={t(
            spec.unit === 'percent'
              ? 'agents.autoCompact.typePercent'
              : 'agents.autoCompact.typeTokens',
          )}
          aria-label={label}
          inputMode={spec.unit === 'percent' ? 'numeric' : 'text'}
          spellCheck={false}
          className="h-10.5! px-2"
        />
        <ComboboxList className="max-h-72 px-1.5 pt-0.5 pb-1.5">
          {(choice: ValueChoice) => (
            <ComboboxItem
              key={choice.key}
              value={choice}
              disabled={choice.disabled}
              className="h-9 rounded-lg py-1 pl-2 data-highlighted:bg-hover"
            >
              <span className="truncate text-menu text-primary">{choice.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{range}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

/** A model the add menu offers: a known Claude model, or what the user typed. */
interface ModelChoice {
  id: string
  name: string | null
  custom?: true
}

const knownName = (id: string): string | null =>
  KNOWN_CLAUDE_MODELS.find((model) => model.id === id)?.name ?? null

function AddModel({
  claude,
  shown,
  disabled,
  onAdd,
}: {
  claude: boolean
  shown: ReadonlySet<string>
  disabled: boolean
  onAdd: (model: string) => void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const text = query.trim()
  // Only Claude Code's models are known to Kettu; other harnesses' ids are typed as they list them.
  const suggestions: ModelChoice[] = claude
    ? KNOWN_CLAUDE_MODELS.filter(
        (model) =>
          !shown.has(model.id) &&
          `${model.name} ${model.id}`.toLowerCase().includes(text.toLowerCase()),
      ).map((model) => ({ id: model.id, name: model.name }))
    : []
  const typed = claude ? canonicalClaudeModel(text) : text
  const choices: ModelChoice[] =
    text !== '' &&
    text.length <= MAX_MODEL_CHARS &&
    !/\s/.test(text) &&
    !shown.has(typed) &&
    !suggestions.some((choice) => choice.id === typed)
      ? [...suggestions, { id: text, name: null, custom: true }]
      : suggestions
  return (
    <Combobox<ModelChoice>
      items={choices}
      filteredItems={choices}
      value={null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(choice) => {
        if (!choice) return
        onAdd(claude ? canonicalClaudeModel(choice.id) : choice.id)
        setOpen(false)
      }}
      itemToStringLabel={(choice) => choice.id}
      isItemEqualToValue={(a, b) => a.id === b.id}
      autoHighlight
    >
      <ComboboxPrimitive.Trigger
        render={
          <button
            type="button"
            className="ui-ss-select k-select"
            aria-label={t('agents.claudeSettings.compact.add')}
            disabled={disabled}
          />
        }
      >
        <span className="k-select__value">{t('agents.claudeSettings.compact.choose')}</span>
        <Icon icon={ArrowDown01Icon} size={14} />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent align="end" sideOffset={6} className="flex w-72 flex-col">
        <ComboboxInput
          showTrigger={false}
          placeholder={t(
            claude ? 'agents.claudeSettings.compact.search' : 'agents.autoCompact.typeModel',
          )}
          aria-label={t('agents.claudeSettings.compact.search')}
          spellCheck={false}
          className="h-10.5! px-2"
        />
        <ComboboxList className="px-1.5 pt-0.5 pb-1.5">
          {(choice: ModelChoice) => (
            <ComboboxItem
              key={choice.id}
              value={choice}
              className="h-9 gap-2.5 rounded-lg py-1 pr-2 pl-2 data-highlighted:bg-hover [&>span.absolute]:hidden"
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-menu text-primary">
                  {choice.custom
                    ? t('agents.claudeSettings.compact.addCustom', { id: choice.id })
                    : choice.name}
                </span>
                {!choice.custom && (
                  <span className="truncate text-small text-tertiary">{choice.id}</span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{t('agents.claudeSettings.compact.noMatch')}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

export function AutoCompactRows({ status }: { status: AgentStatus }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
  // Models added here, kept as rows until the file holds a value for them.
  const [added, setAdded] = useState<string[]>([])
  const [save, busy, saveError] = useAction()
  const load = useCallback(
    () =>
      request('agents.autoCompact', { agentId: status.id }).then(
        (settings) => setRead({ state: 'ready', settings }),
        (error: unknown) => setRead({ state: 'failed', error: errorMessage(error) }),
      ),
    [request, status.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const claude = status.harnessId === 'claude-code'
  const settings = read.state === 'ready' ? read.settings : null
  const spec: CompactSpec | null = settings
    ? { unit: settings.unit, min: settings.min, max: settings.max }
    : null
  const rows: AutoCompactRow[] = settings?.models
    ? [
        ...settings.models,
        ...added
          .filter((model) => !settings.models!.some((row) => row.model === model))
          .map((model) => ({ model, name: null, value: null, other: null })),
      ]
    : []
  const name = t(claude ? 'agents.claudeSettings.compact.name' : 'agents.autoCompact.name')
  const unit = settings?.unit ?? (claude ? 'window' : 'trigger')
  const perModel = settings?.models != null
  const description = claude
    ? t('agents.claudeSettings.compact.description')
    : [
        t(`agents.autoCompact.description.${unit}`, { harness: status.harnessName }),
        perModel ? t('agents.autoCompact.perModel') : null,
      ]
        .filter(Boolean)
        .join(' ')
  const auto = t('agents.claudeSettings.auto')
  const note = saveError ?? (read.state === 'failed' ? read.error : null)

  const write = (model: string | null, value: number | null): void =>
    save(async () => {
      await request('agents.setAutoCompact', { agentId: status.id, change: { model, value } })
      await load()
    })

  const allName = t('agents.claudeSettings.compact.all')
  return (
    <RowShell id="auto-compact">
      <div className="k-block">
        <BlockLine text={<RowText name={name} description={description} />}>
          {!perModel && read.state === 'loading' && <Skel width={210} className="k-skel--field" />}
          {!perModel && settings && spec && (
            <ValuePicker
              spec={spec}
              value={settings.all}
              other={settings.allOther}
              auto={auto}
              label={name}
              disabled={busy}
              onChange={(value) => write(null, value)}
            />
          )}
        </BlockLine>
        {perModel && settings && spec && (
          <>
            <BlockLine text={<RowText name={allName} />}>
              <ValuePicker
                spec={spec}
                value={settings.all}
                other={settings.allOther}
                auto={auto}
                label={`${name}: ${allName}`}
                disabled={busy}
                onChange={(value) => write(null, value)}
              />
            </BlockLine>
            {rows.map((row) => {
              const rowName = row.name ?? (claude ? knownName(row.model) : null) ?? row.model
              return (
                <BlockLine key={row.model} text={<RowText name={rowName} />}>
                  <ValuePicker
                    spec={spec}
                    value={row.value}
                    other={row.other}
                    auto={
                      settings.all === null && settings.allOther === null
                        ? auto
                        : t('agents.claudeSettings.compact.sameAsAll')
                    }
                    label={`${name}: ${rowName}`}
                    disabled={busy}
                    onChange={(value) => write(row.model, value)}
                  />
                </BlockLine>
              )
            })}
            <BlockLine text={<RowText name={t('agents.claudeSettings.compact.add')} />}>
              <AddModel
                claude={claude}
                shown={new Set(rows.map((row) => row.model))}
                disabled={busy}
                onAdd={(model) =>
                  setAdded((current) => (current.includes(model) ? current : [...current, model]))
                }
              />
            </BlockLine>
          </>
        )}
      </div>
      {note && (
        <p role="status" className="k-row-note k-error" data-wrap="">
          {note}
        </p>
      )}
    </RowShell>
  )
}
