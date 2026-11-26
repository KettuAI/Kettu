// 设置 › 智能体 › Bots 的行内控件组件。

import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SetInput, SettingSwitch } from './controls'
import { useApply } from './use-apply'

const BOT_CONCURRENT_MIN = 1
const BOT_CONCURRENT_MAX = 50

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

function parseConcurrent(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= BOT_CONCURRENT_MIN && value <= BOT_CONCURRENT_MAX
    ? value
    : null
}

/** 整机所有 Bot 共享的最大并发工作会话数输入框。 */
export function BotMaxConcurrentField({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const value = useSettingsStore((s) => s.settings.bots.maxConcurrent)
  const [draft, setDraft] = useState<string | null>(null)
  const [apply, error] = useApply()
  const shown = String(value)
  const invalid = draft !== null && draft.trim() !== '' && parseConcurrent(draft) === null

  const commit = (): void => {
    if (draft === null) return
    const next = parseConcurrent(draft)
    if (draft.trim() !== '' && next === null) return
    setDraft(null)
    if (next === null) return
    if (next !== value) apply({ bots: { maxConcurrent: next } })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isComposing(event)) return
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') {
      event.stopPropagation()
      setDraft(null)
      event.currentTarget.blur()
    }
  }

  return (
    <>
      <ControlError
        error={
          invalid
            ? t('agents.bots.invalid', { min: BOT_CONCURRENT_MIN, max: BOT_CONCURRENT_MAX })
            : error
        }
      />
      <SetInput
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={draft ?? shown}
        inputMode="numeric"
        maxLength={2}
        spellCheck={false}
        autoComplete="off"
        className="k-input--short"
        onFocus={() => setDraft((current) => current ?? shown)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </>
  )
}

/** 允许普通会话 Agent 委派给 Bot 的开关控件。 */
export function BotAllowHandoffSwitch({ label }: { label: string }) {
  const { useSettingsStore } = useHostScope()
  const checked = useSettingsStore((s) => s.settings.bots.allowAgentHandoff)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(next) => apply({ bots: { allowAgentHandoff: next } })}
      />
    </>
  )
}
