import type { ConfigOption } from '@shared/thread'

type Choices = NonNullable<ConfigOption['choices']>

// The main menu holds this many models, each with a number key, before More models.
export const MAIN_MODELS = 4

/** The value whose row stands for the current model: the one it is shown as, else its own. */
export function shownValue(choices: Choices, current: string | undefined): string | undefined {
  return choices.find((c) => c.value === current)?.shownAs ?? current
}

/** The choice whose name stands for the current model, by the same rule as `shownValue`. */
export function shownChoice(
  choices: Choices,
  current: string | undefined,
): Choices[number] | undefined {
  const value = shownValue(choices, current)
  return choices.find((c) => c.value === value)
}

/**
 * The models a menu lists, split into the current ones and the older ones under More models. When
 * the agent marks none as older, the first four are current and the rest go under More models.
 * A choice shown as another is not listed.
 */
export function splitModels(choices: Choices): { current: Choices; older: Choices } {
  const listed = choices.filter((c) => !c.shownAs)
  if (!listed.some((c) => c.older)) {
    return { current: listed.slice(0, MAIN_MODELS), older: listed.slice(MAIN_MODELS) }
  }
  return { current: listed.filter((c) => !c.older), older: listed.filter((c) => c.older) }
}

/**
 * The main menu's models: the current ones, then the chosen one when it is not among them, so the
 * chosen model is always in view.
 */
export function mainModels(choices: Choices, current: string | undefined): Choices {
  const { current: main } = splitModels(choices)
  const chosen = shownChoice(choices, current)
  return chosen && !main.includes(chosen) ? [...main, chosen] : main
}

/** The model a number key chooses among the main menu's first four, for 1 to 4. */
export function numberedModel(main: Choices, key: string): Choices[number] | undefined {
  const n = Number(key)
  return Number.isInteger(n) && n >= 1 && n <= MAIN_MODELS ? main[n - 1] : undefined
}
