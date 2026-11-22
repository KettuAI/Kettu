// The content a driven viewer shows: the served file at once, then any version the window asks
// for, read through the page's `content` capability without loading the page again, so the place
// on screen and a text being typed in stay. Writes go through the same capability.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewerConfig } from '@shared/artifact-types'
import type { ContentNamespace } from '@shared/artifact-runtime/content'
import { contentCapability, readServed, writeFailure } from './boot'

export interface Loaded {
  version: number
  text: string
}

export type WriteResult =
  { ok: true; version: number } | { ok: false; code: 'conflict' | 'invalid' | 'failed' }

export interface ContentSource {
  loaded: Loaded | null
  failed: boolean
  /** The latest version, once the capability answered; only it may be written from. */
  head: number | null
  /** Any version's text, read once. */
  textOf: (version: number) => Promise<string | null>
  /** Writes `text` as the version after `base`. */
  write: (base: number, text: string) => Promise<WriteResult>
  /** The latest version and its text, read again. */
  latest: () => Promise<Loaded | null>
}

export function useSource(config: ViewerConfig, wanted: number | null): ContentSource {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [head, setHead] = useState<number | null>(null)
  const [content, setContent] = useState<ContentNamespace | null>(null)
  const texts = useRef(new Map<number, Promise<string | null>>())

  useEffect(() => {
    let live = true
    readServed(config).then(
      (text) => live && setLoaded((was) => was ?? { version: config.version, text }),
      () => live && setFailed(true),
    )
    void contentCapability().then(async (found) => {
      if (!found || !live) return
      setContent(found)
      const read = await found.read(config.version).catch(() => null)
      if (!read || !live) return
      setLoaded((was) => (was && was.version !== config.version ? was : read))
      setHead(read.head)
      setFailed(false)
    })
    return () => {
      live = false
    }
  }, [config])

  const textOf = useCallback(
    (version: number): Promise<string | null> => {
      if (!content) return Promise.resolve(null)
      let text = texts.current.get(version)
      if (!text) {
        text = content.read(version).then(
          (read) => read.text,
          () => null,
        )
        texts.current.set(version, text)
      }
      return text
    },
    [content],
  )

  // Another version, asked for by the window: read in place of the one shown. Only a new ask
  // reads, so a version this page just wrote is not taken back while the window catches up.
  const shownVersion = useRef<number | null>(null)
  useEffect(() => {
    shownVersion.current = loaded?.version ?? null
  })
  useEffect(() => {
    if (wanted === null || !content || shownVersion.current === wanted) return
    let live = true
    content.read(wanted).then(
      (read) => {
        if (!live) return
        setLoaded({ version: read.version, text: read.text })
        setHead(read.head)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [wanted, content])

  const write = useCallback(
    async (base: number, text: string): Promise<WriteResult> => {
      if (!content) return { ok: false, code: 'failed' }
      try {
        const { version } = await content.write(base, text)
        texts.current.set(version, Promise.resolve(text))
        setLoaded({ version, text })
        setHead(version)
        return { ok: true, version }
      } catch (error) {
        const { code } = writeFailure(error)
        return {
          ok: false,
          code: code === 'conflict' ? 'conflict' : code === 'invalid' ? 'invalid' : 'failed',
        }
      }
    },
    [content],
  )

  const latest = useCallback(async (): Promise<Loaded | null> => {
    if (!content) return null
    const any = await content.read(loaded?.version ?? config.version).catch(() => null)
    if (!any) return null
    const read = any.version === any.head ? any : await content.read(any.head).catch(() => null)
    if (!read) return null
    setHead(read.head)
    return { version: read.version, text: read.text }
  }, [content, loaded?.version, config.version])

  return { loaded, failed: failed && loaded === null, head, textOf, write, latest }
}
