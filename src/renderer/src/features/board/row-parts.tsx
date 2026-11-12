import type { ReactNode } from 'react'
import { clock, shortAgo } from '@renderer/lib/format'
import { useNow, useSeconds } from '@renderer/lib/use-now'

/** How long something has run as "4:02", counting on the one clock every ticking time shares. */
export function Clock({ since }: { since: number }) {
  const now = useSeconds()
  return <span className="kb-clock">{clock(Math.max(0, now - since) / 1000)}</span>
}

export function Ago({ at }: { at: number }) {
  const now = useNow()
  return <>{shortAgo(at, now)}</>
}

/** Content that opens and closes in place, rising out of a soft blur as the thread's folds do. */
export function Fold({ id, open, children }: { id?: string; open: boolean; children: ReactNode }) {
  return (
    <div id={id} className="kb-fold" data-open={open}>
      <div>
        <div>{children}</div>
      </div>
    </div>
  )
}
