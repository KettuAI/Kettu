// A Codebuddy Code agent's site on its page, read from and saved to its settings file on the
// agent's host, with a note for each shell variable that wins over it.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, CodebuddySettings } from '@shared/agent-host'
import { CODEBUDDY_SITES, signsInWithKeyOnly, type CodebuddySite } from '@shared/agents'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SettingSelect, Skel } from './controls'
import { RowLine, RowShell, RowText } from './rows'

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: CodebuddySettings }

type Choice = CodebuddySite | 'automatic' | 'other'

export function CodebuddySettingsRows({ status }: { status: AgentStatus }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
  const [save, busy, saveError] = useAction()
  const load = useCallback(
    () =>
      request('agents.codebuddySettings', { agentId: status.id }).then(
        (settings) => setRead({ state: 'ready', settings }),
        (error: unknown) => setRead({ state: 'failed', error: errorMessage(error) }),
      ),
    [request, status.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const settings = read.state === 'ready' ? read.settings : null
  const keyOnly = signsInWithKeyOnly(status.id)
  const name = t('agents.codebuddy.site.name')
  // Automatic is no choice for an agent that signs in only with a key, unless its file has it.
  const options: { value: Choice; label: string }[] = [
    ...(!keyOnly || settings?.site === 'automatic'
      ? [{ value: 'automatic' as const, label: t('agents.codebuddy.site.automatic') }]
      : []),
    ...CODEBUDDY_SITES.map((site) => ({
      value: site,
      label: t(`agents.codebuddy.site.${site}`),
    })),
    ...(settings?.site === 'other'
      ? [
          {
            value: 'other' as const,
            label: t('agents.codebuddy.site.other', { value: settings.otherSite ?? '' }),
          },
        ]
      : []),
  ]
  const note = saveError ?? (read.state === 'failed' ? read.error : null)

  return (
    <RowShell>
      <RowLine
        text={
          <RowText
            name={name}
            description={t(
              keyOnly
                ? 'agents.codebuddy.site.descriptionKey'
                : 'agents.codebuddy.site.description',
            )}
          />
        }
      >
        {read.state === 'loading' ? (
          <Skel width={210} className="k-skel--field" />
        ) : (
          <SettingSelect<Choice>
            label={name}
            value={settings?.site ?? 'automatic'}
            disabled={settings === null || busy}
            options={options}
            onChange={(next) => {
              if (next === 'other') return
              save(async () => {
                await request('agents.setCodebuddySite', {
                  agentId: status.id,
                  change: { site: next },
                })
                await load()
              })
            }}
          />
        )}
      </RowLine>
      {settings?.shellOverrides.map((variable) => (
        <p key={variable} role="status" className="k-row-note" data-wrap="">
          {t(`agents.codebuddy.override.${variable}`)}
        </p>
      ))}
      {note && (
        <p role="status" className="k-row-note k-error" data-wrap="">
          {note}
        </p>
      )}
    </RowShell>
  )
}
