import type { MarkBodyProps } from './index'

// Pi mark: https://pi.dev/logo-auto.svg, the logo of earendil-works/pi (MIT), Copyright (c) 2025 Mario Zechner.
const PI_CORAL = 'M165.29 165.29H517.36V400H400V282.65H165.29Z'
const PI_BLUE = 'M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z'
const PI_YELLOW = 'M517.36 400H634.72V634.72H517.36Z'

export const viewBox = '0 0 800 800'

/** The three parts in their brand colors, or all in `currentColor` when `mono`. */
export function Body({ mono }: MarkBodyProps) {
  return (
    <>
      <path fill={mono ? 'currentColor' : 'var(--brand-pi-coral)'} d={PI_CORAL} />
      <path fill={mono ? 'currentColor' : 'var(--brand-pi-blue)'} d={PI_BLUE} />
      <path fill={mono ? 'currentColor' : 'var(--brand-pi-yellow)'} d={PI_YELLOW} />
    </>
  )
}
