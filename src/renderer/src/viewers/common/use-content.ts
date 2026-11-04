// The content a viewer shows, and the user's edits of it: shown at once from the served file,
// editable once the page's `content` capability answers for the latest version.

import { useEffect, useState } from 'react'
import type { ViewerConfig } from '@shared/artifact-types'
import type { ContentNamespace } from '@shared/artifact-runtime/content'
import { contentCapability, readServed, writeFailure } from './boot'

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; version: number }
  | { kind: 'conflict' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'failed' }

export interface Content {
  text: string | null
  failed: boolean
  /** The latest version, when this page shows it and may write the next. */
  head: number | null
  status: SaveStatus
  save(text: string): Promise<boolean>
  dismiss(): void
}

export function useContent(config: ViewerConfig): Content {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [editor, setEditor] = useState<{ content: ContentNamespace; head: number } | null>(null)
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' })

  useEffect(() => {
    let live = true
    readServed(config).then(
      (served) => live && setText((shown) => shown ?? served),
      () => live && setFailed(true),
    )
    void contentCapability()
      .then(async (content) => {
        if (!content || !live) return
        const read = await content.read(config.version)
        if (!live) return
        setText(read.text)
        setFailed(false)
        if (read.head === read.version) setEditor({ content, head: read.head })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [config])

  return {
    text,
    failed: failed && text === null,
    head: editor?.head ?? null,
    status,
    dismiss: () => setStatus({ kind: 'idle' }),
    save: async (next) => {
      if (!editor) return false
      setStatus({ kind: 'saving' })
      try {
        const { version } = await editor.content.write(editor.head, next)
        setText(next)
        setEditor({ ...editor, head: version })
        setStatus({ kind: 'saved', version })
        return true
      } catch (error) {
        const { code, message } = writeFailure(error)
        setStatus(
          code === 'conflict'
            ? { kind: 'conflict' }
            : code === 'invalid' || code === 'too_large'
              ? { kind: 'invalid', reason: message }
              : { kind: 'failed' },
        )
        return false
      }
    },
  }
}
