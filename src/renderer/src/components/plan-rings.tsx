import { LIMIT_STROKE, type LimitLevel } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'

export interface PlanRing {
  id: string
  /** The whole percentage used. */
  percent: number
  level: LimitLevel
}

/**
 * One ring per plan window, the first innermost, each filled to how much of it is used, on a
 * track in a tint of its own color. `size` is the diagram's width in pixels.
 */
export function PlanRings({
  rings,
  size,
  stroke,
  gap,
  className,
}: {
  rings: readonly PlanRing[]
  size: number
  stroke: number
  gap: number
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
        return (
          <g key={ring.id} className={LIMIT_STROKE[ring.level]}>
            <circle
              cx={center}
              cy={center}
              r={r}
              fill="none"
              strokeWidth={stroke}
              className="stroke-current opacity-(--ring-tint)"
            />
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
