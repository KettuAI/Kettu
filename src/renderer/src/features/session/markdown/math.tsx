import 'katex/dist/katex.min.css'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BlockCopy } from './block-frame'
import { drawTex, type TexError } from './tex'

/** The source of a formula KaTeX could not read, with the part it stopped at in red. */
function Fallback({ tex, error }: { tex: string; error: TexError }) {
  return (
    <code data-math-error="" title={error.message}>
      {tex.slice(0, error.start)}
      <mark>{tex.slice(error.start, error.end)}</mark>
      {tex.slice(error.end)}
    </code>
  )
}

/** KaTeX's drawing of `tex` in an element React leaves to it, or the marked source. */
function Formula({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [error, setError] = useState<{ tex: string; error: TexError } | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const failed = drawTex(tex, display, ref.current)
    setError(failed ? { tex, error: failed } : null)
  }, [tex, display])
  return (
    <>
      <span ref={ref} hidden={!!error} data-math-inline={display ? undefined : ''} />
      {error && <Fallback tex={error.tex} error={error.error} />}
    </>
  )
}

/** A formula in a line of text, at the text's own line height. */
export function InlineMath({ tex }: { tex: string }) {
  return <Formula tex={tex} display={false} />
}

/**
 * A formula on a line of its own: centered on a subtle ground, numbered on the right in the
 * message's order (globals.css counts them), with Copy LaTeX on hover.
 */
export function MathBlock({ tex, isIncomplete }: { tex: string; isIncomplete: boolean }) {
  const { t } = useTranslation('session')
  const source = tex.replace(/\n$/, '')
  return (
    <div data-math-block="" className="group/math">
      {isIncomplete ? <code>{source}</code> : <Formula tex={source} display />}
      <span className="math-copy">
        <BlockCopy text={source} label={t('block.copyLatex')} />
      </span>
    </div>
  )
}
