import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PageKey } from '@shared/artifact-runtime/page-messages'
import { useEditorFrame, type ArtifactEditor, type EditorFrame } from './editor'
import { FrameLink } from './frame-link'

/**
 * A live frame that passes its page's keys on to `onKey`, so stepping through frames goes on
 * after a click into one: through the editor's link to the page when there is an editor, which
 * drives the same page, else through a link of its own. `origin` is the artifact's URL without
 * its last slash.
 */
export function useKeyedFrame(
  editor: ArtifactEditor | undefined,
  page: number | null,
  origin: string,
  onKey: (key: PageKey) => void,
): {
  frame: EditorFrame | null
  ref: (element: HTMLIFrameElement | null) => void
  onLoad: () => void
} {
  const driven = useEditorFrame(editor, page)
  const own = useMemo(() => (editor ? null : new FrameLink(origin, () => {})), [editor, origin])
  const element = useRef<HTMLIFrameElement | null>(null)
  const loaded = useRef(false)
  const handler = useRef(onKey)
  useEffect(() => {
    handler.current = onKey
  })

  useEffect(() => {
    if (!own) return
    own.attach(element.current)
    own.open()
    if (loaded.current) own.loaded()
    return () => own.dispose()
  }, [own])

  const link = driven.frame?.link ?? own
  useEffect(() => {
    if (!link) return
    link.keys((key) => handler.current(key))
    return () => link.keys(null)
  }, [link])

  const drivenRef = driven.ref
  const drivenLoad = driven.onLoad
  return {
    frame: driven.frame,
    ref: useCallback(
      (el: HTMLIFrameElement | null) => {
        element.current = el
        drivenRef(el)
        own?.attach(el)
      },
      [drivenRef, own],
    ),
    onLoad: useCallback(() => {
      loaded.current = true
      drivenLoad()
      own?.loaded()
    }, [drivenLoad, own]),
  }
}
