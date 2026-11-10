// A Claude Code agent's common settings on its page: each model's auto-compact window and the
// prompt cache duration, read from and saved to its settings file on the agent's host.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, ClaudeSettings } from '@shared/agent-host'
import { AUTO_COMPACT_STEPS, PROMPT_CACHE_TTLS, type PromptCacheTtl } from '@shared/agents'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SettingSelect, Skel } from './controls'
import { BlockLine, RowLine, RowShell, RowText } from './rows'

const AUTO = 'auto'

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: ClaudeSettings }

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

  const auto = t('agents.claudeSettings.auto')
  const settings = read.state === 'ready' ? read.settings : null
  const compactNote =
    compactError ??
    (read.state === 'failed'
      ? read.error
      : settings && settings.compact.length === 0
        ? t('agents.claudeSettings.unused')
        : null)
  const cacheNote = cacheError ?? (read.state === 'failed' ? read.error : null)
  const cacheName = t('agents.claudeSettings.cache.name')
  return (
    <>
      <RowShell>
        <div className="k-block">
          <BlockLine
            text={
              <RowText
                name={t('agents.claudeSettings.compact.name')}
                description={t('agents.claudeSettings.compact.description')}
              />
            }
          />
          {read.state === 'loading' && (
            <BlockLine text={<Skel width={120} />}>
              <Skel width={210} className="k-skel--field" />
            </BlockLine>
          )}
          {settings?.compact.map((row) => {
            const name = row.name ?? row.model
            return (
              <BlockLine key={row.model} text={<RowText name={name} />}>
                <SettingSelect
                  label={`${t('agents.claudeSettings.compact.name')}: ${name}`}
                  value={row.window === null ? AUTO : String(row.window)}
                  disabled={compactBusy}
                  options={windowOptions(row.window, auto)}
                  onChange={(next) =>
                    saveCompact(async () => {
                      await request('agents.setClaudeSetting', {
                        agentId: status.id,
                        change: {
                          setting: 'autoCompactWindow',
                          model: row.model,
                          value: next === AUTO ? null : Number(next),
                        },
                      })
                      await load()
                    })
                  }
                />
              </BlockLine>
            )
          })}
        </div>
        {compactNote && (
          <p
            role="status"
            className={
              compactError || read.state === 'failed' ? 'k-row-note k-error' : 'k-row-note'
            }
            data-wrap=""
          >
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
                    change: {
                      setting: 'promptCacheTtl',
                      value: isTtl(next) ? next : null,
                    },
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
