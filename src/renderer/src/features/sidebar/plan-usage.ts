import type { PlanLimit } from '@shared/agent-host'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The window to show for an agent: a reached one first, then the fullest. A window whose reset
 * time has passed is skipped, because its percentage is from before the reset.
 */
export function tightestLimit(limits: readonly PlanLimit[], now: number): PlanLimit | null {
  const current = limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
  const reached = current.find((l) => l.state === 'reached')
  if (reached) return reached
  const known = current.filter((l) => l.usedPercent !== null)
  const fullest = known.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]
  return fullest ?? current[0] ?? null
}

/** Time left in its two largest units: "42m", "5h 12m", "1d 5h"; null once it has passed. */
export function countdown(ms: number): string | null {
  if (ms <= 0) return null
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))}m`
  if (ms < DAY) {
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return `${Math.floor(ms / HOUR)}h${minutes ? ` ${minutes}m` : ''}`
  }
  const hours = Math.floor((ms % DAY) / HOUR)
  return `${Math.floor(ms / DAY)}d${hours ? ` ${hours}h` : ''}`
}
