import { LIMIT_STROKE, type LimitLevel } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'

export interface PlanRing {
  id: string
  /** The whole percentage used. */
  percent: number
  level: LimitLevel
  /** The share of the window's time already passed, drawn a step darker on its track. */
  passed?: number | null
}

/**
 * One ring per plan window, the first innermost, each filled to how much of it is used, on a
 * track in a tint of its own color, or in a neutral gray with `track="neutral"`; a tinted track
 * darkens a step over the time already passed when a ring says how much. `size` is the diagram's
 * width in pixels.
 */
export function PlanRings({
  rings,
  size,
  stroke,
  gap,
  track = 'tint',
  className,
}: {
  rings: readonly PlanRing[]
  size: number
  stroke: number
  gap: number
  track?: 'tint' | 'neutral'
  className?: string
}) {
  const center = size / 2
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={cn('shrink-0 -rotate-90', className)}
    >
      {rings.map((ring, i) => {
        const fromOuter = rings.length - 1 - i
        const r = center - stroke / 2 - fromOuter * (stroke + gap)
        const length = 2 * Math.PI * r
        const share = Math.min(100, ring.percent) / 100
        const passed = track === 'tint' && ring.passed ? Math.min(1, ring.passed) : 0
        return (
          <g key={ring.id} className={LIMIT_STROKE[ring.level]}>
            <circle
              cx={center}
              cy={center}
              r={r}
              fill="none"
              strokeWidth={stroke}
              className={
                track === 'neutral'
                  ? 'stroke-(--bg-selected)'
                  : 'stroke-current opacity-(--ring-tint)'
              }
            />
            {passed > 0 && (
              <circle
                cx={center}
                cy={center}
                r={r}
                fill="none"
                strokeWidth={stroke}
                strokeDasharray={`${passed * length} ${length}`}
                className="stroke-current opacity-(--ring-passed)"
              />
            )}
            {share > 0 && (
              <circle
                cx={center}
                cy={center}
                r={r}
                fill="none"
                strokeWidth={stroke}
                // A full ring has no gap for a round cap to show in.
                strokeLinecap={share < 1 ? 'round' : 'butt'}
                strokeDasharray={`${share * length} ${length}`}
                className="stroke-current"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}
