import { useRef, useState } from 'react'

/** Which commits show their files, and whether a card is on screen, shared by every row. */
export function useCommitCards() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  // Once one commit's card shows, the next opens at once.
  const [warm, setWarm] = useState(false)
  const cooling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCard = (shown: boolean): void => {
    if (cooling.current) clearTimeout(cooling.current)
    if (shown) setWarm(true)
    else cooling.current = setTimeout(() => setWarm(false), 300)
  }
  const toggle = (oid: string) => () =>
    setOpen((now) => {
      const next = new Set(now)
      if (next.has(oid)) next.delete(oid)
      else next.add(oid)
      return next
    })
  return { open, warm, onCard, toggle }
}

export type Cards = ReturnType<typeof useCommitCards>
