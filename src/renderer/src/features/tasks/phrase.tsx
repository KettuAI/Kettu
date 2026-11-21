import { Fragment, useMemo } from 'react'
import { phraseRuns } from './wrapped-lines'

/**
 * Text that wraps only between words, as `wrappedLines` measures it: its parent keeps CJK runs
 * whole (`break-keep`), and a break may fall only where a `<wbr>` is.
 */
export function Phrase({ text }: { text: string }) {
  const runs = useMemo(() => phraseRuns(text), [text])
  return runs.map((run, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {run}
    </Fragment>
  ))
}
