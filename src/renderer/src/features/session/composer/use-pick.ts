import { useState } from 'react'
import { booleanConfigValue, type ConfigOption } from '@shared/thread'

/** Asks the agent to change an option; resolves to whether it did. */
export type Select = (optionId: string, value: string | boolean) => Promise<boolean>

// How long a pick may stand in for the agent's value when no new value arrives.
const SETTLE_MS = 1500

/**
 * A select option's value, showing the user's pick at once. The agent's new value arrives with the
 * session's next patch, after the request has settled, so the pick stands until that value lands,
 * the request fails or `SETTLE_MS` passes.
 */
export function useSelectPick(
  option: ConfigOption | undefined,
  onSelect: Select,
): [string | undefined, (value: string) => void] {
  const actual = option === undefined ? undefined : String(option.value)
  const [pending, setPending] = useState<string | null>(null)
  if (pending !== null && pending === actual) setPending(null)
  const shown = pending ?? actual
  const pick = (value: string) => {
    if (!option || value === shown) return
    setPending(value)
    const clear = () => setPending((p) => (p === value ? null : p))
    void onSelect(option.id, value).then((ok) => {
      if (ok) setTimeout(clear, SETTLE_MS)
      else clear()
    })
  }
  return [shown, pick]
}

/**
 * The switches' values in effect, each flip shown at once until the agent's own value lands or
 * `SETTLE_MS` passes.
 */
export function useSwitchPicks(onSelect: Select) {
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const valueOf = (option: ConfigOption): boolean => {
    const actual = booleanConfigValue(option) === true
    return option.id in pending ? pending[option.id]! : actual
  }
  const settle = (id: string, value: boolean) =>
    setPending((p) => {
      if (p[id] !== value) return p
      const rest = { ...p }
      delete rest[id]
      return rest
    })
  const pick = (option: ConfigOption, value: boolean) => {
    setPending((p) => ({ ...p, [option.id]: value }))
    void onSelect(option.id, value).then((ok) => {
      if (ok) setTimeout(() => settle(option.id, value), SETTLE_MS)
      else settle(option.id, value)
    })
  }
  return { valueOf, pick }
}
