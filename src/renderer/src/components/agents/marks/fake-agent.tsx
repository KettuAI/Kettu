export const viewBox = '0 0 24 24'

/** A dashed square, in `currentColor` at every size. */
export function Body() {
  return (
    <rect
      x="4"
      y="4"
      width="16"
      height="16"
      rx="4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeDasharray="3 3"
    />
  )
}
