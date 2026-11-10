// A Claude Code agent's common settings on its page: the auto-compact window for all models and
// for each model, and the prompt cache duration, read from and saved to its settings file on the
// agent's host.

import { useCallback, useEffect, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, ClaudeCompactRow, ClaudeSettings } from '@shared/agent-host'
import {
  AUTO_COMPACT_STEPS,
  canonicalClaudeModel,
  KNOWN_CLAUDE_MODELS,
  PROMPT_CACHE_TTLS,
  type PromptCacheTtl,
} from '@shared/agents'
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
import { SettingSelect, Skel } from './controls'
import { BlockLine, RowLine, RowShell, RowText } from './rows'

const AUTO = 'auto'
const MAX_MODEL_CHARS = 256

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: ClaudeSettings }

/** A model the add menu offers: a known one, or what the user typed. */
interface ModelChoice {
  id: string
  name: string | null
  custom?: true
}

const knownName = (id: string): string | null =>
  KNOWN_CLAUDE_MODELS.find((model) => model.id === id)?.name ?? null

/** A window as the select writes it: 200K, 750K, 1M. */
function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  return `${Math.round(tokens / 1000)}K`
}

/** The steps beside Auto, with a window the file holds that is not one of them kept in place. */
function windowOptions(current: number | null, auto: string): { value: string; label: string }[] {
  const steps =
    current !== null && !AUTO_COMPACT_STEPS.includes(current)
      ? [...AUTO_COMPACT_STEPS, current].sort((a, b) => a - b)
      : AUTO_COMPACT_STEPS
  return [
    { value: AUTO, label: auto },
    ...steps.map((tokens) => ({ value: String(tokens), label: windowLabel(tokens) })),
  ]
}

function isTtl(value: string): value is PromptCacheTtl {
  return (PROMPT_CACHE_TTLS as readonly string[]).includes(value)
}

export function ClaudeSettingsRows({ status }: { status: AgentStatus }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
  // Models typed in, kept as rows until the file holds a window for them.
  const [added, setAdded] = useState<string[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saveCompact, compactBusy, compactError] = useAction()
  const [saveCache, cacheBusy, cacheError] = useAction()
  const load = useCallback(
    () =>
      request('agents.claudeSettings', { agentId: status.id }).then(
        (settings) => setRead({ state: 'ready', settings }),
        (error: unknown) => setRead({ state: 'failed', error: errorMessage(error) }),
      ),
    [request, status.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const settings = read.state === 'ready' ? read.settings : null
  const rows: ClaudeCompactRow[] = settings
    ? [
        ...settings.compact,
        ...added
          .filter((model) => !settings.compact.some((row) => row.model === model))
          .map((model) => ({ model, name: null, window: null })),
      ]
    : []
  const auto = t('agents.claudeSettings.auto')
  const compactName = t('agents.claudeSettings.compact.name')
  const cacheName = t('agents.claudeSettings.cache.name')
  const compactNote = compactError ?? (read.state === 'failed' ? read.error : null)
  const cacheNote = cacheError ?? (read.state === 'failed' ? read.error : null)

  const saveWindow = (model: string | null, next: string): void =>
    saveCompact(async () => {
      await request('agents.setClaudeSetting', {
        agentId: status.id,
        change: {
          setting: 'autoCompactWindow',
          model,
          value: next === AUTO ? null : Number(next),
        },
      })
      await load()
    })

  const addModel = (model: string): void => {
    const id = canonicalClaudeModel(model)
    setAdded((current) => (current.includes(id) ? current : [...current, id]))
    setMenuOpen(false)
  }

  // Known models not shown yet that match the text, and the text itself when it could be an id.
  const text = query.trim()
  const shownIds = new Set(rows.map((row) => row.model))
  const suggestions: ModelChoice[] = KNOWN_CLAUDE_MODELS.filter(
    (model) =>
      !shownIds.has(model.id) &&
      `${model.name} ${model.id}`.toLowerCase().includes(text.toLowerCase()),
  ).map((model) => ({ id: model.id, name: model.name }))
  const typed = canonicalClaudeModel(text)
  const choices: ModelChoice[] =
    text !== '' &&
    text.length <= MAX_MODEL_CHARS &&
    !/\s/.test(text) &&
    !shownIds.has(typed) &&
    !suggestions.some((choice) => choice.id === typed)
      ? [...suggestions, { id: text, name: null, custom: true }]
      : suggestions

  return (
    <>
      <RowShell>
        <div className="k-block">
          <BlockLine
            text={
              <RowText
                name={compactName}
                description={t('agents.claudeSettings.compact.description')}
              />
            }
          />
          {read.state === 'loading' && (
            <BlockLine text={<Skel width={120} />}>
              <Skel width={210} className="k-skel--field" />
            </BlockLine>
          )}
          {settings && (
            <BlockLine text={<RowText name={t('agents.claudeSettings.compact.all')} />}>
              <SettingSelect
                label={`${compactName}: ${t('agents.claudeSettings.compact.all')}`}
                value={settings.defaultWindow === null ? AUTO : String(settings.defaultWindow)}
                disabled={compactBusy}
                options={windowOptions(settings.defaultWindow, auto)}
                onChange={(next) => saveWindow(null, next)}
              />
            </BlockLine>
          )}
          {settings &&
            rows.map((row) => {
              const name = row.name ?? knownName(row.model) ?? row.model
              return (
                <BlockLine key={row.model} text={<RowText name={name} />}>
                  <SettingSelect
                    label={`${compactName}: ${name}`}
                    value={row.window === null ? AUTO : String(row.window)}
                    disabled={compactBusy}
                    options={windowOptions(
                      row.window,
                      settings.defaultWindow === null
                        ? auto
                        : t('agents.claudeSettings.compact.sameAsAll'),
                    )}
                    onChange={(next) => saveWindow(row.model, next)}
                  />
                </BlockLine>
              )
            })}
          {settings && (
            <BlockLine text={<RowText name={t('agents.claudeSettings.compact.add')} />}>
              <Combobox<ModelChoice>
                items={choices}
                filteredItems={choices}
                value={null}
                open={menuOpen}
                onOpenChange={(next) => {
                  setMenuOpen(next)
                  if (!next) setQuery('')
                }}
                inputValue={query}
                onInputValueChange={setQuery}
                onValueChange={(choice) => choice && addModel(choice.id)}
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
                      disabled={compactBusy}
                    />
                  }
                >
                  <span className="k-select__value">
                    {t('agents.claudeSettings.compact.choose')}
                  </span>
                  <Icon icon={ArrowDown01Icon} size={14} />
                </ComboboxPrimitive.Trigger>
                <ComboboxContent align="end" sideOffset={6} className="flex w-72 flex-col">
                  <ComboboxInput
                    showTrigger={false}
                    placeholder={t('agents.claudeSettings.compact.search')}
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
            </BlockLine>
          )}
        </div>
        {compactNote && (
          <p role="status" className="k-row-note k-error" data-wrap="">
            {compactNote}
          </p>
        )}
      </RowShell>
      <RowShell>
        <RowLine
          text={
            <RowText name={cacheName} description={t('agents.claudeSettings.cache.description')} />
          }
        >
          {read.state === 'loading' ? (
            <Skel width={210} className="k-skel--field" />
          ) : (
            <SettingSelect
              label={cacheName}
              value={settings?.promptCacheTtl ?? AUTO}
              disabled={settings === null || cacheBusy}
              options={[
                { value: AUTO, label: auto },
                ...PROMPT_CACHE_TTLS.map((ttl) => ({
                  value: ttl,
                  label: t(`agents.claudeSettings.cache.${ttl}`),
                })),
              ]}
              onChange={(next) =>
                saveCache(async () => {
                  await request('agents.setClaudeSetting', {
                    agentId: status.id,
                    change: { setting: 'promptCacheTtl', value: isTtl(next) ? next : null },
                  })
                  await load()
                })
              }
            />
          )}
        </RowLine>
        {cacheNote && (
          <p role="status" className="k-row-note k-error" data-wrap="">
            {cacheNote}
          </p>
        )}
      </RowShell>
    </>
  )
}
