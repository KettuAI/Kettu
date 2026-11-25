// The rows of Settings › Agents › Sessions agents start.

import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isStartedLimit,
  STARTED_LIMIT_MAX,
  STARTED_LIMIT_MIN,
  type StartedLimitKey,
} from '@shared/started-sessions'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SetInput } from './controls'
import { useApply } from './use-apply'

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

function parseLimit(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return isStartedLimit(value) ? value : null
}

/** One limit as a number field: it applies on Enter or leaving it, Esc puts it back. */
export function LimitField({ limit, label }: { limit: StartedLimitKey; label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const value = useSettingsStore((s) => s.settings.startedSessions[limit])
  const [draft, setDraft] = useState<string | null>(null)
  const [apply, error] = useApply()
  const shown = String(value)
  const invalid = draft !== null && draft.trim() !== '' && parseLimit(draft) === null
  const commit = (): void => {
    if (draft === null) return
    const next = parseLimit(draft)
    if (draft.trim() !== '' && next === null) return
    setDraft(null)
    if (next === null) return
    if (next !== value) apply({ startedSessions: { [limit]: next } })
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
            ? t('agents.started.invalid', { min: STARTED_LIMIT_MIN, max: STARTED_LIMIT_MAX })
            : error
        }
      />
      <SetInput
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={draft ?? shown}
        inputMode="numeric"
        maxLength={3}
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
