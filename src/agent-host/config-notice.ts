// The notice a session shows when it could not keep values it was meant to have, such as a fork
// whose agent refused its source's mode, or a session whose agent would not take its own back.

import type { ConfigOption } from '@shared/thread'
import { t } from './i18n'

/** A value a session could not keep: `actual` is null when it has no such option. */
export type LostValue =
  | {
      type: 'select'
      /** The option's name, such as "Mode". */
      option: string
      /** The names of the value meant to be kept and of the one the session runs with. */
      wanted: string
      actual: string | null
    }
  | { type: 'boolean'; option: string; wanted: boolean; actual: boolean | null }

// The mode matters most, since a looser one runs commands the source would have refused.
const RANK: Record<ConfigOption['category'], number> = {
  mode: 0,
  model: 1,
  model_config: 2,
  thought_level: 3,
  other: 4,
}

/** What a user reads for a choice of `option`: its name, or the raw value for an unknown one. */
export function valueName(option: ConfigOption, value: string): string {
  return option.choices?.find((choice) => choice.value === value)?.name ?? value
}

function lostValue(option: ConfigOption, now: ConfigOption | undefined): LostValue {
  if (option.type === 'boolean' && typeof option.value === 'boolean') {
    return {
      type: 'boolean',
      option: option.name,
      wanted: option.value,
      actual: typeof now?.value === 'boolean' ? now.value : null,
    }
  }
  return {
    type: 'select',
    option: option.name,
    wanted: valueName(option, String(option.value)),
    actual: now && typeof now.value === 'string' ? valueName(now, now.value) : null,
  }
}

/** The values of `wanted` that `actual` does not hold, mode first. */
export function lostValues(
  wanted: readonly ConfigOption[],
  actual: readonly ConfigOption[],
): LostValue[] {
  const lost: { rank: number; value: LostValue }[] = []
  for (const option of wanted) {
    const same = actual.find((o) => o.id === option.id && o.type === option.type)
    if (same?.value === option.value) continue
    lost.push({ rank: RANK[option.category], value: lostValue(option, same) })
  }
  return lost.sort((a, b) => a.rank - b.rank).map(({ value }) => value)
}

/** What the notice speaks of: a new fork, or a session that attached to its agent again. */
export type NoticeSubject = 'fork' | 'session'

// A switch has a sentence for each case, not its value in a slot: "on" and "off" would be
// translated words glued into the sentence. A switch that was off and is missing lost nothing.
function line(lost: LostValue, subject: NoticeSubject): string | null {
  const { option } = lost
  if (lost.type === 'boolean') {
    if (lost.actual === null)
      return lost.wanted ? t(`notice.lostValues.${subject}.cannotTurnOn`, { option }) : null
    return t(lost.wanted ? 'notice.lostValues.isOff' : 'notice.lostValues.isOn', { option })
  }
  return lost.actual === null
    ? t(`notice.lostValues.${subject}.missing`, { option, wanted: lost.wanted })
    : t('notice.lostValues.differs', { option, wanted: lost.wanted, actual: lost.actual })
}

/**
 * The notice entry's text for the values a session could not keep; null when it kept them all.
 * With `held`, it also says that the message the session was to send waits in its queue.
 */
export function lostValuesNotice(
  lost: readonly LostValue[],
  { subject = 'fork', held = false }: { subject?: NoticeSubject; held?: boolean } = {},
): { severity: 'warning'; title: string; description: string } | null {
  const lines = lost.map((value) => line(value, subject)).filter((text) => text !== null)
  if (lines.length === 0) return null
  return {
    severity: 'warning',
    title: t(`notice.lostValues.${subject}.title`),
    description: [
      ...lines,
      t('notice.lostValues.next'),
      ...(held ? [t('notice.lostValues.held')] : []),
    ].join('\n'),
  }
}
