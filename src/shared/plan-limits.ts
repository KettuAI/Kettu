// Which of an agent's plan-limit windows hold back one of its models.

import type { PlanLimit } from './agent-host'
import type { ConfigOption } from './thread'

const words = (...texts: (string | undefined)[]): Set<string> =>
  new Set(
    texts
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )

/**
 * The windows that hold back the model `model` has chosen. A per-model weekly window, such as
 * `seven_day_fable`, counts only on a model that names it, so a used-up Fable week does not stop
 * Opus; a window naming none of the menu's models counts for all of them, and so does every
 * window when the model is not known.
 */
export function limitsForModel(
  limits: readonly PlanLimit[],
  model: ConfigOption | undefined,
): PlanLimit[] {
  const choices = model?.choices ?? []
  const current = choices.find((c) => c.value === model?.value)
  if (!current) return [...limits]
  const known = words(...choices.flatMap((c) => [c.value, c.name, c.modelId]))
  const own = words(current.value, current.name, current.modelId, current.description)
  return limits.filter((limit) => {
    const scoped = /^seven_day_(.+)$/.exec(limit.window)
    const names = scoped?.[1]?.split('_') ?? []
    if (names.length === 0 || !names.every((name) => known.has(name))) return true
    return names.every((name) => own.has(name))
  })
}
