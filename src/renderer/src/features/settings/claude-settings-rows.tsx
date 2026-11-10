// A Claude Code agent's common settings on its page: the auto-compact window for all models and
// for each model, and the prompt cache duration, read from and saved to its settings file on the
// agent's host.

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, ClaudeCompactRow, ClaudeSettings } from '@shared/agent-host'
import {
  AUTO_COMPACT_STEPS,
  canonicalClaudeModel,
  PROMPT_CACHE_TTLS,
  type PromptCacheTtl,
} from '@shared/agents'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SetButton, SetInput, SettingSelect, Skel } from './controls'
import { BlockLine, RowLine, RowShell, RowText } from './rows'

const AUTO = 'auto'
const MAX_MODEL_CHARS = 256

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: ClaudeSettings }

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

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
  const [draft, setDraft] = useState('')
  const [draftInvalid, setDraftInvalid] = useState(false)
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

  const addModel = (): void => {
    const model = draft.trim()
    if (model.length === 0) return
    if (model.length > MAX_MODEL_CHARS || /\s/.test(model)) {
      setDraftInvalid(true)
      return
    }
    const id = canonicalClaudeModel(model)
    setAdded((current) => (current.includes(id) ? current : [...current, id]))
    setDraft('')
    setDraftInvalid(false)
  }

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
              const name = row.name ?? row.model
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
            <BlockLine
              text={
                <SetInput
                  value={draft}
                  placeholder={t('agents.claudeSettings.compact.addPlaceholder')}
                  aria-label={t('agents.claudeSettings.compact.add')}
                  aria-invalid={draftInvalid || undefined}
                  spellCheck={false}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setDraftInvalid(false)
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && !isComposing(event) && addModel()}
                  className="k-input--wide"
                />
              }
            >
              <SetButton variant="ghost" disabled={draft.trim().length === 0} onClick={addModel}>
                {t('agents.claudeSettings.compact.add')}
              </SetButton>
            </BlockLine>
          )}
        </div>
        {(compactNote || draftInvalid) && (
          <p role="status" className="k-row-note k-error" data-wrap="">
            {compactNote ?? t('agents.claudeSettings.compact.invalidModel')}
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
