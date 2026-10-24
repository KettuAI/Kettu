import {
  lockupGeometry,
  MARK_BOX,
  MARK_PATHS,
  markVersionFor,
  WORDMARK,
  type LockupLayout,
} from '@shared/brand'
import { cn } from '@renderer/lib/utils'

const MARK_VIEW_BOX = `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`

/** The mark alone, `width` px wide, in the version that width calls for. Decorative. */
export function BrandMark({ width, className }: { width: number; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox={MARK_VIEW_BOX}
      width={width}
      height={(width * MARK_BOX.height) / MARK_BOX.width}
      fill="currentColor"
      className={cn('shrink-0 text-brand-overbench', className)}
    >
      <path d={MARK_PATHS[markVersionFor(width)]} />
    </svg>
  )
}

/** The mark and the wordmark in their fixed proportions, sized by the wordmark's font size. */
export function BrandLockup({
  fontSize,
  layout = 'horizontal',
  className,
}: {
  fontSize: number
  layout?: LockupLayout
  className?: string
}) {
  const g = lockupGeometry(layout)
  const scale = fontSize / 100
  const { mark, text } = g
  return (
    <svg
      role="img"
      aria-label="OverBench"
      viewBox={`0 0 ${g.width} ${g.height}`}
      width={g.width * scale}
      height={g.height * scale}
      fill="currentColor"
      className={cn('shrink-0 text-brand-overbench', className)}
    >
      <svg x={mark.x} y={mark.y} width={mark.width} height={mark.height} viewBox={MARK_VIEW_BOX}>
        <path d={MARK_PATHS[markVersionFor(mark.width * scale)]} />
      </svg>
      <path transform={`translate(${text.x} ${text.y})`} d={WORDMARK.path} />
    </svg>
  )
}
