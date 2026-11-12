import type { MarkBodyProps } from './index'

// Junie mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
// Brand color: https://junie.jetbrains.com/favicons/favicon.svg.
const TAIL =
  'M25 15H35V16.75C35 29 30.5001 35 16.5001 35H15V25H16.5001C22.6251 25 25 22.875 25 16.75V15Z'

export const viewBox = '0 0 40 40'

export function Body({ mono }: MarkBodyProps) {
  return (
    <g fill={mono ? 'currentColor' : 'var(--brand-junie)'}>
      <path d={TAIL} />
      <rect x="5" y="15" width="10" height="10" />
      <rect x="15" y="5" width="10" height="10" />
    </g>
  )
}
