import type { MarkBodyProps } from './index'

// Agoragentic mark: the nav mark of https://agoragentic.com, drawn in its stylesheet
// (site-nav.css) as a coral square framing a navy one.
const FRAME =
  'M6.72 0H21.28A6.72 6.72 0 0 1 28 6.72V21.28A6.72 6.72 0 0 1 21.28 28H6.72A6.72 6.72 0 0 1 0 21.28V6.72A6.72 6.72 0 0 1 6.72 0Z'
const CORE =
  'M9.28 6.08H18.72A3.2 3.2 0 0 1 21.92 9.28V18.72A3.2 3.2 0 0 1 18.72 21.92H9.28A3.2 3.2 0 0 1 6.08 18.72V9.28A3.2 3.2 0 0 1 9.28 6.08Z'

export const viewBox = '-2 -2 32 32'

export function Body({ mono }: MarkBodyProps) {
  if (mono) return <path fill="currentColor" fillRule="evenodd" d={FRAME + CORE} />
  return (
    <>
      <path fill="var(--brand-agoragentic)" d={FRAME} />
      <path fill="var(--brand-agoragentic-core)" d={CORE} />
    </>
  )
}
