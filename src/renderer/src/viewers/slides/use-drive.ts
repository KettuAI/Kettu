// The window's side of the deck, as the slides viewer sees it: the state it drives the viewer with,
// the one-off asks and the notes typed under a slide, and the reports the page script passes back.

import { useEffect, useSyncExternalStore } from 'react'
import { RUNTIME_VERSION } from '@shared/artifact-capabilities'
import {
  DECK_MAX_SLIDE,
  DECK_NOTES_CHARS,
  DECK_REPORT_EVENT,
  type DeckDrive,
  type DeckReport,
  type DeckState,
} from '@shared/artifact-runtime/deck-sheet'

export type DeckAsk = { do: 'undo' | 'retry' } | { do: 'notes'; slide: number; text: string }

/** Only the window that holds the frame drives it. */
function fromParent(event: MessageEvent): DeckDrive | null {
  if (event.source !== window.parent || window.parent === window) return null
  const data = event.data as Partial<DeckDrive> | null
  if (!data || typeof data !== 'object' || data.v !== RUNTIME_VERSION) return null
  return data.kind === 'select-deck' ||
    data.kind === 'select-deck-do' ||
    data.kind === 'select-deck-notes'
    ? (data as DeckDrive)
    : null
}

// The window drives the frame once it loads, which can be before the viewer has mounted, so the
// state is kept here from the start.
let latest: DeckState | null = null
const changed = new Set<() => void>()
let asked: ((ask: DeckAsk) => void) | null = null
window.addEventListener('message', (event) => {
  const drive = fromParent(event)
  if (!drive) return
  if (drive.kind === 'select-deck') {
    latest = drive.state
    for (const notify of changed) notify()
  } else if (drive.kind === 'select-deck-do') {
    if (drive.do === 'undo' || drive.do === 'retry') asked?.({ do: drive.do })
  } else if (
    Number.isSafeInteger(drive.slide) &&
    drive.slide >= 1 &&
    drive.slide <= DECK_MAX_SLIDE &&
    typeof drive.text === 'string'
  ) {
    asked?.({ do: 'notes', slide: drive.slide, text: drive.text.slice(0, DECK_NOTES_CHARS) })
  }
})
const subscribe = (notify: () => void): (() => void) => {
  changed.add(notify)
  return () => changed.delete(notify)
}

/** The state the window drives the viewer with; null while nothing drives it, as in a copy. */
export function useDrive(onAsk: (ask: DeckAsk) => void): DeckState | null {
  useEffect(() => {
    asked = onAsk
    return () => {
      if (asked === onAsk) asked = null
    }
  })
  return useSyncExternalStore(subscribe, () => latest)
}

/** Hands a report to the page script, which sends it to the window. */
export function report(deck: DeckReport): void {
  window.dispatchEvent(new CustomEvent(DECK_REPORT_EVENT, { detail: deck }))
}
