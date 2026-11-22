import type { ConfigOption } from '@shared/thread'
import type { DialStop } from './effort-dial'

export type SelectOption = ConfigOption & {
  type: 'select'
  choices: NonNullable<ConfigOption['choices']>
}

/** Splits `provider/model` names, so the provider can step back and the button show the model. */
export function splitName(name: string): [prefix: string, rest: string] {
  const at = name.lastIndexOf('/') + 1
  return [name.slice(0, at), name.slice(at)]
}

const isDefaultChoice = (c: { value: string; name: string }): boolean =>
  /^default$/i.test(c.value) || /^default\b/i.test(c.name)

// RegExp.escape needs Node 24, and the tests run on Node 22.
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Drops the option's own name when every level repeats it, as Pi's "Thinking: low" does. */
function withoutHeading<T extends { name: string }>(heading: string, levels: T[]): T[] {
  if (!heading) return levels
  const prefix = new RegExp(`^${escapeRegExp(heading)}\\s*:\\s*`, 'i')
  const strip = (name: string) => name.replace(prefix, '')
  if (!levels.every((l) => strip(l.name) !== l.name && strip(l.name) !== '')) return levels
  return levels.map((l) => ({ ...l, name: strip(l.name) }))
}

/**
 * The effort dial's stops and the one shown as chosen: the agent's Default first, when it has one,
 * then its levels. Default stands for no level, so a session on it shows none.
 */
export function dialStops(
  effort: SelectOption,
  value: string | undefined,
): { stops: DialStop[]; shown: string | undefined } {
  const levels: DialStop[] = withoutHeading(
    effort.name,
    effort.choices.filter((c) => !isDefaultChoice(c)),
  ).map((c) => ({ value: c.value, name: c.name }))
  const fallback = effort.choices.find(isDefaultChoice)
  const stops = fallback
    ? [
        {
          value: fallback.value,
          // "Default (High)" names the level the agent picks, which the stop does not claim.
          name: fallback.name.replace(/\s*[(\uff08].*$/, '') || fallback.name,
          isDefault: true,
        },
        ...levels,
      ]
    : levels
  const shown = stops.some((s) => s.value === value)
    ? value
    : (fallback?.value ?? levels[Math.floor((levels.length - 1) / 2)]?.value)
  return { stops, shown }
}

/** The level the composer's button shows: none on the agent's Default. */
export function shownLevel(effort: SelectOption, value: string | undefined): string | null {
  const { stops, shown } = dialStops(effort, value)
  const stop = stops.find((s) => s.value === shown)
  return stop && !stop.isDefault ? stop.name : null
}
