import { useId } from 'react'
import type { MarkBodyProps } from './index'

// Nova mark: https://github.com/Compass-Agentic-Platform/nova/blob/main/assets/nova.svg (MIT),
// Copyright (c) 2026 Compass Agentic Platform.
export const viewBox = '0 0 24 24'

export function Body({ mono }: MarkBodyProps) {
  const id = useId()
  const ring = mono ? 'currentColor' : `url(#${id}-ring)`
  const arrow = mono ? 'currentColor' : `url(#${id}-arrow)`
  return (
    <>
      {!mono && (
        <defs>
          <linearGradient id={`${id}-ring`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="var(--brand-nova-1)" />
            <stop offset=".5" stopColor="var(--brand-nova-2)" />
            <stop offset="1" stopColor="var(--brand-nova-3)" />
          </linearGradient>
          <linearGradient id={`${id}-arrow`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="var(--brand-nova-arrow-1)" />
            <stop offset="1" stopColor="var(--brand-nova-arrow-2)" />
          </linearGradient>
        </defs>
      )}
      <circle cx="12" cy="12" r="9" fill="none" stroke={ring} strokeWidth="1.5" />
      <circle
        cx="12"
        cy="12"
        r="7"
        fill="none"
        stroke={mono ? 'currentColor' : 'var(--brand-nova-2)'}
        strokeWidth="0.5"
        opacity="0.5"
      />
      <line x1="12" y1="12" x2="21" y2="21" stroke={arrow} strokeWidth="2" strokeLinecap="round" />
      <polygon points="22,22 19,20.5 20.5,19" fill={arrow} />
      <line x1="12" y1="12" x2="3" y2="3" stroke={arrow} strokeWidth="2" strokeLinecap="round" />
      <polygon points="2,2 5,3.5 3.5,5" fill={arrow} />
      <circle cx="12" cy="12" r="2" fill={ring} />
      {!mono && <circle cx="12" cy="12" r="1" fill="var(--brand-nova-core)" />}
    </>
  )
}
