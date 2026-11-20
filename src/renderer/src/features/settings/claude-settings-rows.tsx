// A Claude Code agent's prompt cache duration on its page, read from and saved to its settings
// file on the agent's host. Its auto-compact windows are the auto-compact rows every harness has.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, ClaudeSettings } from '@shared/agent-host'
import { PROMPT_CACHE_TTLS, type PromptCacheTtl } from '@shared/agents'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SettingSelect, Skel } from './controls'
import { RowLine, RowShell, RowText } from './rows'

const AUTO = 'auto'

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: ClaudeSettings }

function isTtl(value: string): value is PromptCacheTtl {
  return (PROMPT_CACHE_TTLS as readonly string[]).includes(value)
}

export function ClaudeSettingsRows({ status }: { status: AgentStatus }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
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
  const auto = t('agents.claudeSettings.auto')
  const cacheName = t('agents.claudeSettings.cache.name')
  const cacheNote = cacheError ?? (read.state === 'failed' ? read.error : null)

  return (
    <RowShell id="prompt-cache">
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
  )
}
