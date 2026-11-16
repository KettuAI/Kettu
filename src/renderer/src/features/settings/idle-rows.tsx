// The Idle sessions group's rows: the warning while a Claude Code version is in fallback, and the
// choice of when idle sessions let their agent go.

import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  IDLE_LIMITS,
  IDLE_RELEASE_MODES,
  IN_VIEW_MINUTES,
  OUT_OF_VIEW_MINUTES,
  type IdleReleaseState,
  type IdleSessionsSettings,
} from '@shared/idle-release'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, Segmented, SettingSelect } from './controls'
import { BlockLine, Notice } from './rows'
import { useApply } from './use-apply'

const NO_LIMIT = 'none'

export function FallbackNotice({ version }: { version: string }) {
  const { t } = useTranslation('settings')
  return (
    <Notice
      variant="warning"
      className="k-notice--row"
      title={t('agents.idle.fallback.title', { version })}
    >
      {t('agents.idle.fallback.body')}
    </Notice>
  )
}

function duration(t: TFunction<'settings'>, minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0
    ? t('agents.idle.hours', { count: minutes / 60 })
    : t('agents.idle.minutes', { count: minutes })
}

/** Auto's line: the memory state and the rule it gives now. */
function autoLine(t: TFunction<'settings'>, { memory, rule }: IdleReleaseState): string | null {
  if (!rule) return null
  if (rule.now) return t('agents.idle.auto.critical')
  if (rule.limit === 0) return t('agents.idle.auto.noneKept')
  const values = {
    outOfView: duration(t, rule.outOfView),
    inView: duration(t, rule.inView),
    limit: rule.limit,
  }
  if (memory === 'unknown') return t('agents.idle.auto.unknown', values)
  const level = memory === 'tight' ? 'tight' : 'plenty'
  return rule.limit === null
    ? t(`agents.idle.auto.${level}`, values)
    : t(`agents.idle.auto.${level}Limit`, values)
}

export function IdleRelease({ text, state }: { text: ReactNode; state: IdleReleaseState | null }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const idle = useSettingsStore((s) => s.settings.idleSessions) ?? DEFAULT_SETTINGS.idleSessions
  const [apply, error] = useApply()
  const set = (change: Partial<IdleSessionsSettings>) => apply({ idleSessions: change })
  const line = idle.release === 'auto' && state ? autoLine(t, state) : null
  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error} />
        <Segmented
          label={t('agents.idle.release.name')}
          value={idle.release}
          options={IDLE_RELEASE_MODES.map((mode) => ({
            value: mode,
            label: t(`agents.idle.release.${mode}`),
          }))}
          onChange={(release) => set({ release })}
        />
      </BlockLine>
      {line && <p className="k-block-note">{line}</p>}
      {idle.release === 'never' && <p className="k-block-note">{t('agents.idle.never')}</p>}
      {idle.release === 'custom' && (
        <div className="k-subrows ui-ss-rise">
          <div className="k-subrow">
            <span className="ui-sg-label">
              <b>{t('agents.idle.outOfView.name')}</b>
              <small>{t('agents.idle.outOfView.description')}</small>
            </span>
            <SettingSelect
              label={t('agents.idle.outOfView.name')}
              value={String(idle.outOfView)}
              options={OUT_OF_VIEW_MINUTES.map((minutes) => ({
                value: String(minutes),
                label: duration(t, minutes),
              }))}
              onChange={(next) => {
                const outOfView = OUT_OF_VIEW_MINUTES.find((minutes) => String(minutes) === next)
                if (outOfView) set({ outOfView })
              }}
            />
          </div>
          <div className="k-subrow">
            <span className="ui-sg-label">
              <b>{t('agents.idle.inView.name')}</b>
              <small>{t('agents.idle.inView.description')}</small>
            </span>
            <SettingSelect
              label={t('agents.idle.inView.name')}
              value={String(idle.inView)}
              options={IN_VIEW_MINUTES.map((minutes) => ({
                value: String(minutes),
                label: duration(t, minutes),
              }))}
              onChange={(next) => {
                const inView = IN_VIEW_MINUTES.find((minutes) => String(minutes) === next)
                if (inView) set({ inView })
              }}
            />
          </div>
          <div className="k-subrow">
            <span className="ui-sg-label">
              <b>{t('agents.idle.limit.name')}</b>
              <small>{t('agents.idle.limit.description')}</small>
            </span>
            <SettingSelect
              label={t('agents.idle.limit.name')}
              value={idle.limit === null ? NO_LIMIT : String(idle.limit)}
              options={IDLE_LIMITS.map((limit) => ({
                value: limit === null ? NO_LIMIT : String(limit),
                label: limit === null ? t('agents.idle.limit.none') : String(limit),
              }))}
              onChange={(next) => {
                const limit = IDLE_LIMITS.find(
                  (value) => (value === null ? NO_LIMIT : String(value)) === next,
                )
                if (limit !== undefined) set({ limit })
              }}
            />
          </div>
          <p className="k-subnote">{t('agents.idle.cacheNote')}</p>
        </div>
      )}
    </>
  )
}
