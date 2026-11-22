/**
 * The thin bar beside a long frame that says how far down it is, which takes no pointer: the
 * thumb is to the track as the view is to everything that scrolls.
 */
export function PositionBar({
  left,
  top,
  track,
  view,
  range,
  scrolled,
  dark = false,
}: {
  left: number
  top: number
  track: number
  view: number
  range: number
  scrolled: number
  dark?: boolean
}) {
  if (range <= 0 || track <= 0) return null
  const thumb = Math.max(28, (track * view) / (view + range))
  const at = (Math.min(range, Math.max(0, scrolled)) / range) * (track - thumb)
  return (
    <span
      aria-hidden
      className="k-position"
      data-dark={dark || undefined}
      style={{ left, top, height: track }}
    >
      <i style={{ height: thumb, transform: `translateY(${at}px)` }} />
    </span>
  )
}
