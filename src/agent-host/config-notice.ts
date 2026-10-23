// The notice a session shows when it could not keep values it was meant to have, such as a fork
// whose agent refused its source's mode.

import type { ConfigOption } from '@shared/thread'
import { t } from './i18n'

export interface LostValue {
  /** The option's name, such as "Mode". */
  option: string
  /** The name of the value that was meant to be kept. */
  wanted: string
  /** The name of the value the session runs with, or null when it has no such option. */
  actual: string | null
}

// The mode matters most, since a looser one runs commands the source would have refused.
const RANK: Record<ConfigOption['category'], number> = {
  mode: 0,
  model: 1,
  model_config: 2,
  thought_level: 3,
  other: 4,
}

/** What a user reads for `value` of `option`: a choice's name, or on and off. */
export function valueName(option: ConfigOption, value: string | boolean): string {
  if (typeof value === 'boolean') return t(value ? 'notice.lostValues.on' : 'notice.lostValues.off')
  return option.choices?.find((choice) => choice.value === value)?.name ?? value
}

/** The values of `wanted` that `actual` does not hold, mode first. */
export function lostValues(
  wanted: readonly ConfigOption[],
  actual: readonly ConfigOption[],
): LostValue[] {
  const lost: { rank: number; value: LostValue }[] = []
  for (const option of wanted) {
    const now = actual.find((o) => o.id === option.id)
    if (now?.value === option.value) continue
    lost.push({
      rank: RANK[option.category],
      value: {
        option: option.name,
        wanted: valueName(option, option.value),
        actual: now ? valueName(now, now.value) : null,
      },
    })
  }
  return lost.sort((a, b) => a.rank - b.rank).map(({ value }) => value)
}

/** The notice entry's text for the values a session could not keep; null when it kept them all. */
export function lostValuesNotice(
  lost: readonly LostValue[],
): { severity: 'warning'; title: string; description: string } | null {
  if (lost.length === 0) return null
  const lines = lost.map(({ option, wanted, actual }) =>
    actual === null
      ? t('notice.lostValues.missing', { option, wanted })
      : t('notice.lostValues.differs', { option, wanted, actual }),
  )
  return {
    severity: 'warning',
    title: t('notice.lostValues.title'),
    description: [...lines, t('notice.lostValues.next')].join('\n'),
  }
}
