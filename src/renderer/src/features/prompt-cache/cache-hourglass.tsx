import { HourglassIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useCacheLeft } from './cache-phase'

/** The steps the sand moves in, so the hourglass re-renders a dozen times over a cache's life. */
const STEPS = 12

// The inside of Lucide's hourglass on its 24-unit grid, within the stroke: each bulb is a box 8
// wide over a triangle down to the neck, whose sides run at 45 degrees.
const LEFT = 8
const RIGHT = 16
const MIDDLE = 12
const HALF = 4
const TOP = 3
const TOP_CORNER = 6.59
const NECK_TOP = 10.59
const NECK_BOTTOM = 13.41
const BOTTOM_CORNER = 17.41
const BOTTOM = 21
const TRIANGLE = HALF * HALF
const BULB = TRIANGLE + (RIGHT - LEFT) * (TOP_CORNER - TOP)

const points = (...xy: number[][]) => xy.map(([x, y]) => `${x},${y}`).join(' ')

/** The sand in each bulb for the share left, by area: the top holds what is left. */
function sand(share: number): [top: string, bottom: string] {
  const above = share * BULB
  const below = BULB - above
  let top: string
  if (above <= TRIANGLE) {
    const h = Math.sqrt(above)
    top = points([MIDDLE - h, NECK_TOP - h], [MIDDLE + h, NECK_TOP - h], [MIDDLE, NECK_TOP])
  } else {
    const y = TOP_CORNER - (above - TRIANGLE) / (RIGHT - LEFT)
    top = points([LEFT, y], [RIGHT, y], [RIGHT, TOP_CORNER], [MIDDLE, NECK_TOP], [LEFT, TOP_CORNER])
  }
  const box = (RIGHT - LEFT) * (BOTTOM - BOTTOM_CORNER)
  let bottom: string
  if (below <= box) {
    const y = BOTTOM - below / (RIGHT - LEFT)
    bottom = points([LEFT, y], [RIGHT, y], [RIGHT, BOTTOM], [LEFT, BOTTOM])
  } else {
    // What is still empty is a triangle at the neck.
    const h = Math.sqrt(Math.max(0, BULB - below))
    bottom = points(
      [MIDDLE - h, NECK_BOTTOM + h],
      [MIDDLE + h, NECK_BOTTOM + h],
      [RIGHT, BOTTOM_CORNER],
      [RIGHT, BOTTOM],
      [LEFT, BOTTOM],
      [LEFT, BOTTOM_CORNER],
    )
  }
  return [top, bottom]
}

/** Lucide's `Hourglass` with the sand of a cache's lifetime: what is left on top, the rest below. */
export function CacheHourglass({
  expiresAt,
  ttl,
  className,
}: {
  expiresAt: number
  ttl: number
  /** Its size, as for an icon. */
  className?: string
}) {
  const share = useCacheLeft(expiresAt, (left) => Math.ceil((left / ttl) * STEPS) / STEPS) ?? 0
  const [top, bottom] = sand(Math.min(1, share))
  return (
    <span aria-hidden className={cn('relative inline-grid shrink-0', className)}>
      <HourglassIcon className="size-full" />
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 size-full">
        <polygon points={top} />
        <polygon points={bottom} />
      </svg>
    </span>
  )
}
