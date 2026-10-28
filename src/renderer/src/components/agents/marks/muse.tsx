import type { MarkBodyProps } from './index'

// Muse Code mark: https://meta-models.github.io/muse-code-sdk/1.4/favicon.svg (Meta).
const MUSE = 'M14 46V18h8l10 15 10-15h8v28h-8V31L32 46 22 31v15z'

export const viewBox = '0 0 64 64'

/** The M in its brand color, or in `currentColor` when `mono`. */
export function Body({ mono }: MarkBodyProps) {
  return <path fill={mono ? 'currentColor' : 'var(--brand-muse)'} d={MUSE} />
}
