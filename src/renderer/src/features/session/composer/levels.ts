import type { ConfigOption } from '@shared/thread'

export type SelectOption = ConfigOption & {
  type: 'select'
  choices: NonNullable<ConfigOption['choices']>
}

export type EffortTier = 'high' | 'max'

// Agents name their levels freely; these names mark the top ones, compared without case or dashes.
const EFFORT_TIERS: Record<string, EffortTier> = {
  xhigh: 'high',
  extrahigh: 'high',
  veryhigh: 'high',
  max: 'max',
  maximum: 'max',
  ultra: 'max',
  ultrathink: 'max',
  ultracode: 'max',
}

export function tierOf(effort: SelectOption, value: string | undefined): EffortTier | null {
  const choice = effort.choices.find((c) => c.value === value)
  if (!choice) return null
  const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  return EFFORT_TIERS[key(choice.value)] ?? EFFORT_TIERS[key(choice.name)] ?? null
}

/** Splits `provider/model` names, so the provider can step back and the button show the model. */
export function splitName(name: string): [prefix: string, rest: string] {
  const at = name.lastIndexOf('/') + 1
  return [name.slice(0, at), name.slice(at)]
}

const isDefaultChoice = (c: { value: string; name: string }): boolean =>
  /^default$/i.test(c.value) || /^default\b/i.test(c.name)

const mentions = (text: string, name: string): boolean =>
  new RegExp(`\\b${RegExp.escape(name.toLowerCase())}\\b`).test(text)

/**
 * The option's levels without the choice that leaves the level to the agent. That choice is one
 * of the levels in effect, so it gets no segment of its own; when the agent names the level it
 * stands for, as in "Default (High)", the thumb rests there.
 */
export function levelsOf(effort: SelectOption, value: string | undefined) {
  const levels = effort.choices.filter((c) => !isDefaultChoice(c))
  const fallback = effort.choices.find(isDefaultChoice)
  const usesDefault = !!fallback && fallback.value === value
  const said = usesDefault ? `${fallback.name} ${fallback.description ?? ''}`.toLowerCase() : ''
  // The longest name first, so "Default (Extra High)" stands for Extra High, not High.
  const byLength = [...levels].sort((a, b) => b.name.length - a.name.length)
  const standsFor = usesDefault ? byLength.find((l) => mentions(said, l.name)) : undefined
  return {
    levels,
    fallback,
    usesDefault,
    /** The level shown as chosen; none while the default stands for a level the agent does not name. */
    shown: usesDefault ? standsFor?.value : value,
  }
}
