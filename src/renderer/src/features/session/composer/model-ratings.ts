// Speed, quality and cost from 1 to 5 for the model menu's bars. Illustrative only: no agent
// reports such numbers, so they come from this table by model family; unknown models get none.

export interface ModelRating {
  speed: number
  quality: number
  cost: number
}

const FAMILIES: [RegExp, ModelRating][] = [
  [/fable/i, { speed: 1, quality: 5, cost: 5 }],
  [/opus/i, { speed: 2, quality: 5, cost: 4 }],
  [/sonnet/i, { speed: 4, quality: 4, cost: 3 }],
  [/haiku/i, { speed: 5, quality: 3, cost: 1 }],
  [/\bsol\b|-sol\b/i, { speed: 2, quality: 5, cost: 4 }],
  [/terra/i, { speed: 3, quality: 4, cost: 3 }],
  [/luna/i, { speed: 5, quality: 3, cost: 2 }],
  [/nano/i, { speed: 5, quality: 2, cost: 1 }],
  [/mini/i, { speed: 5, quality: 3, cost: 1 }],
  [/codex/i, { speed: 3, quality: 4, cost: 3 }],
  [/gpt-?\d/i, { speed: 3, quality: 4, cost: 3 }],
]

const clamp = (n: number) => Math.min(5, Math.max(1, n))

/** The family's rating; an older version rates a step lower, a long context costs a step more. */
export function modelRating(
  choice: { value: string; name: string; older?: true },
  older = !!choice.older,
): ModelRating | null {
  const text = `${choice.value} ${choice.name}`
  const found = FAMILIES.find(([pattern]) => pattern.test(text))?.[1]
  if (!found) return null
  const long = /\b1m\b|1m context|\[1m\]/i.test(text)
  return {
    speed: found.speed,
    quality: clamp(found.quality - (older ? 1 : 0)),
    cost: clamp(found.cost + (long ? 1 : 0)),
  }
}
