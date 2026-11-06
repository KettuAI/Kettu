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

// RegExp.escape needs Node 24, and the tests run on Node 22.
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentions = (text: string, name: string): boolean =>
  new RegExp(`\\b${escapeRegExp(name.toLowerCase())}\\b`).test(text)

/** The level the Default choice stands for, by its name or description, if the agent names one. */
function defaultStandsFor(
  fallback: { name: string; description?: string } | undefined,
  levels: { value: string; name: string }[],
) {
  if (!fallback) return undefined
  const said = `${fallback.name} ${fallback.description ?? ''}`.toLowerCase()
  // The longest name first, so "Default (Extra High)" stands for Extra High, not High.
  return [...levels]
    .sort((a, b) => b.name.length - a.name.length)
    .find((l) => mentions(said, l.name))
}

// The providers' documented default effort, for an agent whose Default choice sends none, such as
// OpenCode's (platform.claude.com/docs/en/build-with-claude/effort).
const PROVIDER_DEFAULT_EFFORT: [pattern: RegExp, level: string][] = [
  [/claude-(opus|haiku)-5-5/, 'medium'],
  [/claude-/, 'high'],
]

/** The level a model runs at when the agent sends none, as its provider documents it. */
function providerDefault(model: string | undefined, levels: { value: string }[]) {
  const id = model?.toLowerCase() ?? ''
  const level = PROVIDER_DEFAULT_EFFORT.find(([pattern]) => pattern.test(id))?.[1]
  return levels.find((l) => l.value === level)
}

/**
 * The option's levels without the choice that leaves the level to the agent, and the level shown
 * as chosen. That choice is one of the levels in effect, so it gets no segment of its own: it
 * shows as the level it names, as in "Default (High)", else the level the model's provider
 * documents, else the middle level, a guess for a provider that documents none.
 */
export function levelsOf(effort: SelectOption, value: string | undefined, model?: string) {
  const levels = effort.choices.filter((c) => !isDefaultChoice(c))
  const fallback = effort.choices.find(isDefaultChoice)
  const isLevel = levels.some((l) => l.value === value)
  const standsFor = isLevel
    ? undefined
    : (defaultStandsFor(fallback, levels) ??
      providerDefault(model, levels) ??
      levels[Math.floor((levels.length - 1) / 2)])
  return { levels, shown: isLevel ? value : standsFor?.value }
}
