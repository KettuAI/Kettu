import { useId } from 'react'
import type { MarkBodyProps } from './index'

// Harn mark: https://github.com/burin-labs/harn (Apache-2.0), Copyright 2026 Burin Labs, LLC.
export const viewBox = '0 0 32 32'

export function Body({ mono }: MarkBodyProps) {
  const id = useId()
  return (
    <>
      {!mono && (
        <defs>
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="8" y1="6" x2="24" y2="26">
            <stop stopColor="var(--brand-harn-1)" />
            <stop offset="17%" stopColor="var(--brand-harn-2)" />
            <stop offset="33%" stopColor="var(--brand-harn-3)" />
            <stop offset="50%" stopColor="var(--brand-harn-4)" />
            <stop offset="67%" stopColor="var(--brand-harn-5)" />
            <stop offset="83%" stopColor="var(--brand-harn-6)" />
            <stop offset="100%" stopColor="var(--brand-harn-7)" />
          </linearGradient>
        </defs>
      )}
      <g
        fill="none"
        stroke={mono ? 'currentColor' : `url(#${id})`}
        strokeWidth="2.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9.5 6V25.5" />
        <path d="M9.5 18Q9.5 12.4 16 12.4Q22.5 12.4 22.5 18V25.5" />
      </g>
      <circle cx="22.5" cy="25.5" r="2" fill={mono ? 'currentColor' : 'var(--brand-harn-7)'} />
    </>
  )
}
