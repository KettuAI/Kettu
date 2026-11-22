// The window's side of the document sheet, as the viewer sees it: the state it drives the viewer
// with, the one-off asks, and the reports the page script passes back to it.

import { useEffect, useSyncExternalStore } from 'react'
import { RUNTIME_VERSION } from '@shared/artifact-capabilities'
import {
  DOC_REPORT_EVENT,
  type DocDrive,
  type DocReport,
  type DocState,
} from '@shared/artifact-runtime/document-sheet'

type Ask = Extract<DocDrive, { kind: 'select-doc-do' }>['do']

/** Only the window that holds the frame drives it. */
function fromParent(event: MessageEvent): DocDrive | null {
  if (event.source !== window.parent || window.parent === window) return null
  const data = event.data as Partial<DocDrive> | null
  if (!data || typeof data !== 'object' || data.v !== RUNTIME_VERSION) return null
  return data.kind === 'select-doc' || data.kind === 'select-doc-do' ? (data as DocDrive) : null
}

// The window drives the frame once it loads, which can be before the viewer has mounted, so the
// state is kept here from the start.
let latest: DocState | null = null
const changed = new Set<() => void>()
let asked: ((ask: Ask) => void) | null = null
window.addEventListener('message', (event) => {
  const drive = fromParent(event)
  if (!drive) return
  if (drive.kind === 'select-doc') {
    latest = drive.state
    for (const notify of changed) notify()
  } else asked?.(drive.do)
})
const subscribe = (notify: () => void): (() => void) => {
  changed.add(notify)
  return () => changed.delete(notify)
}

/** The state the window drives the viewer with; null while nothing drives it, as in a copy. */
export function useDrive(onAsk: (ask: Ask) => void): DocState | null {
  useEffect(() => {
    asked = onAsk
    return () => {
      if (asked === onAsk) asked = null
    }
  })
  return useSyncExternalStore(subscribe, () => latest)
}

/** Hands a report to the page script, which sends it to the window. */
export function report(doc: DocReport): void {
  window.dispatchEvent(new CustomEvent(DOC_REPORT_EVENT, { detail: doc }))
}
