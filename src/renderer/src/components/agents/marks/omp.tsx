import { useId } from 'react'
import type { MarkBodyProps } from './index'

// OMP mark: https://omp.sh/favicon.svg, the logo of can1357/oh-my-pi (MIT), Copyright (c) 2025 Mario Zechner.
const OMP = 'M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z'

// Cropped from the logo file's wide margin, so it reads as large as the other marks.
export const viewBox = '7.5 11.5 49 49'

/** The M in its brand gradient, or in `currentColor` when `mono`. */
export function Body({ mono }: MarkBodyProps) {
  const id = useId()
  return (
    <>
      {!mono && (
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="var(--brand-omp-1)" />
            <stop offset=".5" stopColor="var(--brand-omp-2)" />
            <stop offset="1" stopColor="var(--brand-omp-3)" />
          </linearGradient>
        </defs>
      )}
      <path fill={mono ? 'currentColor' : `url(#${id})`} d={OMP} />
    </>
  )
}
