import type { MarkBodyProps } from './index'

// fast-agent mark: https://fast-agent.ai/assets/forward/assets/icon-tile-16.svg (Apache-2.0).
// Copyright 2025 llmindset.co.uk.
export const viewBox = '0 0 100 100'

export function Body({ mono }: MarkBodyProps) {
  return (
    <>
      {!mono && <rect width="100" height="100" rx="22" fill="var(--brand-fast-agent-tile)" />}
      <polyline
        points="36,24 64,50 36,76"
        fill="none"
        stroke={mono ? 'currentColor' : 'var(--brand-fast-agent)'}
        strokeWidth="21"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  )
}
