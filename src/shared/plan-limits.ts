// Which of an agent's plan-limit windows hold back one of its models, and how full one is.

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

const has = (own: Set<string>, name: string): boolean =>
  [...words(name)].every((word) => own.has(word))

/**
 * The windows that hold back the model `model` has chosen. A per-model weekly window, such as
 * `seven_day_fable`, counts only on a model that names it, so a used-up Fable week does not stop
 * Opus; a window naming none of the menu's models counts for all of them, and so does every
 * window when the model is not known. A group's window that lists its models counts only on
 * them, unless no group lists the chosen model.
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
  const grouped = limits.some((limit) => limit.models?.some((name) => has(own, name)))
  return limits.filter((limit) => {
    if (limit.models?.length) return !grouped || limit.models.some((name) => has(own, name))
    const scoped = /^seven_day_(.+)$/.exec(limit.window)
    const names = scoped?.[1]?.split('_') ?? []
    if (names.length === 0 || !names.every((name) => known.has(name))) return true
    return names.every((name) => own.has(name))
  })
}

/** From this share used, a window is nearly used up. */
export const NEAR_PERCENT = 90

/**
 * The one window that tells whether an agent would stop a session on `model`: the used-up one that
 * resets last, since that is when the agent can run again, else the fullest at 90% or more, the
 * later reset on a tie. Only windows that hold the model back count, and a window past its reset
 * is skipped, since its reading is from before it. A window with no known reset is taken as the
 * last to reset. Null when none is used up or nearly.
 */
export function holdingLimit(
  limits: readonly PlanLimit[],
  model: ConfigOption | undefined,
  now: number,
): { limit: PlanLimit; reached: boolean } | null {
  const current = limitsForModel(limits, model).filter(
    (limit) => limit.resetsAt === null || limit.resetsAt > now,
  )
  const resets = (limit: PlanLimit): number => limit.resetsAt ?? Infinity
  const reached = current
    .filter((limit) => limit.state === 'reached')
    .sort((a, b) => resets(b) - resets(a))[0]
  if (reached) return { limit: reached, reached: true }
  const used = (limit: PlanLimit): number => Math.round(limit.usedPercent ?? -1)
  const near = current
    .filter((limit) => used(limit) >= NEAR_PERCENT)
    .sort((a, b) => used(b) - used(a) || resets(b) - resets(a))[0]
  return near ? { limit: near, reached: false } : null
}

const DAY = 24 * 60 * 60_000

/** When a window resets: the clock time today, with the weekday within six days, else the date. */
export function resetTimeText(at: number, now: number, locale: string): string {
  const day = (time: number): number => new Date(time).setHours(0, 0, 0, 0)
  // Rounded, since a day across a clock change is not 24 hours.
  const days = Math.round((day(at) - day(now)) / DAY)
  const clock: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  const options: Intl.DateTimeFormatOptions =
    days === 0
      ? clock
      : days > 0 && days <= 6
        ? { ...clock, weekday: 'short' }
        : { ...clock, month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(locale, options).format(at)
}

/** A plan limit notice: a window at 90%, used up, or reset after it was used up. */
export type PlanLimitNoticeLevel = 'near' | 'reached' | 'reset'

/** How full a plan limit is: under 70% used, 70 to 89%, or 90% and over. */
export type LimitLevel = 'ok' | 'warn' | 'bad'

/**
 * A plan limit's level, which colors its bar wherever one is shown. It goes by the whole
 * percentage the bar shows beside it, so "90%" never sits next to a yellow bar.
 */
export function limitLevel(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): LimitLevel {
  if (limit.state === 'reached') return 'bad'
  const used = Math.round(limit.usedPercent ?? 0)
  if (used >= 90) return 'bad'
  if (used >= 70) return 'warn'
  return 'ok'
}
