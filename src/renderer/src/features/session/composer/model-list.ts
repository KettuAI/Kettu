import type { ConfigOption } from '@shared/thread'

type Choices = NonNullable<ConfigOption['choices']>

// The main menu holds this many models, each with a number key, before More models.
export const MAIN_MODELS = 4

/**
 * The main menu's models: the first four, then the current one when it is not among them, so the
 * chosen model is always in view.
 */
export function mainModels(choices: Choices, current: string | undefined): Choices {
  const first = choices.slice(0, MAIN_MODELS)
  const chosen = current === undefined ? undefined : choices.find((c) => c.value === current)
  return chosen && !first.includes(chosen) ? [...first, chosen] : first
}

/** The model a number key chooses among the first four, for the main menu's 1 to 4. */
export function numberedModel(choices: Choices, key: string): Choices[number] | undefined {
  const n = Number(key)
  return Number.isInteger(n) && n >= 1 && n <= MAIN_MODELS ? choices[n - 1] : undefined
}
