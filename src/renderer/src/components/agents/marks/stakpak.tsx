import type { MarkBodyProps } from './index'

// Stakpak mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
// Brand color: https://stakpak.dev/main-assets/cropped-favicon-192x192.png.
const STEP = 'M6.53 4.412h5.883v3.587H9.471v3.588H3.588V7.999H6.53Z'

export const viewBox = '0 0 16 16'

/** A white step on the brand's teal tile, or the step alone in `currentColor` when `mono`. */
export function Body({ mono }: MarkBodyProps) {
  if (mono) return <path fill="currentColor" d={STEP} />
  return (
    <>
      <rect width="16" height="16" fill="var(--brand-stakpak)" />
      <path fill="var(--brand-tile-ink)" d={STEP} />
    </>
  )
}
