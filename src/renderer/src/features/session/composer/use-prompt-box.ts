import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ATTACHMENT_LIMIT } from '@shared/attachments'
import { onAppEvent, type AppEvent } from '@renderer/app/events'
import { errorMessage } from '@renderer/lib/host'
import {
  selectDraft,
  setDraftAttachments,
  useAttachmentsStore,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import { attachFiles, attachImages, pastedImages, pickAttachments } from './attachments'
import { clearDraft, flushDraft, readDraft, writeDraft } from './drafts'
import type { ComposerEditorHandle } from './editor'

// The state of the box both composers share, the session's and New session's; see PromptBox.

/** What a send takes out of the box, and puts back when it fails. */
export interface Taken {
  prompt: string
  held: DraftAttachment[]
}

export type PromptBoxState = ReturnType<typeof usePromptBox>

/**
 * The box's state, kept in the draft `draft`. `sessionId` is the session whose `insert-into-composer`
 * events it takes besides those for no session; null for New session. While `disabled`, nothing
 * is attached.
 */
export function usePromptBox({
  draft,
  sessionId,
  projectPath,
  disabled,
  onActivity,
}: {
  draft: string
  sessionId: string | null
  projectPath: string | null
  disabled: boolean
  /** Typing, attaching or focusing the box, as New session's prepared session watches for. */
  onActivity?: () => void
}) {
  const { t } = useTranslation('composer')
  const [text, setText] = useState(() => readDraft(draft))
  const [error, setError] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // The caret, or null while a range is selected, for telling which `@` word it is in.
  const [caret, setCaret] = useState<number | null>(null)
  const editor = useRef<ComposerEditorHandle>(null)
  const attachments = useAttachmentsStore(selectDraft(draft))

  useEffect(() => () => flushDraft(draft), [draft])

  const limitError = (left: number) => setError(left > 0 ? t('attachments.limit') : null)

  // A pick that is still open, or waiting for its grants, makes a second one a no-op.
  const picking = useRef(false)
  const full = attachments.length >= ATTACHMENT_LIMIT
  const pick = (kind: 'files' | 'folder') => {
    if (disabled || picking.current) return
    if (full) {
      setError(t('attachments.limit'))
      return
    }
    picking.current = true
    onActivity?.()
    pickAttachments(draft, kind, projectPath)
      .then(limitError, (e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        picking.current = false
      })
  }
  const onEvent = useEffectEvent((event: AppEvent) => {
    if (event.kind === 'add-attachments') pick('files')
    if (event.kind === 'drop-attachments' && event.draft === draft && !disabled) {
      onActivity?.()
      attachFiles(draft, event.files).then(limitError, (e: unknown) => setError(errorMessage(e)))
    }
  })

  useEffect(
    () =>
      onAppEvent((event) => {
        onEvent(event)
        if (event.kind === 'focus-composer') editor.current?.focus()
        if (
          event.kind === 'insert-into-composer' &&
          (!event.sessionId || event.sessionId === sessionId)
        ) {
          const current = editor.current?.text() ?? ''
          const next = current ? `${current.replace(/\s+$/, '')}\n\n${event.text}` : event.text
          setText(next)
          writeDraft(draft, next)
          setCaret(null)
          editor.current?.setText(next)
          requestAnimationFrame(() => editor.current?.focus())
        }
      }),
    [draft, sessionId],
  )

  /** Typing changed the text: its state, its draft, and a slash list Esc closed. */
  const changed = (next: string) => {
    setText(next)
    writeDraft(draft, next)
    onActivity?.()
    if (!next.startsWith('/')) setSlashDismissed(false)
  }
  /** Puts `next` in the box with the caret at `at`, the end by default. */
  const update = (next: string, at = next.length) => {
    changed(next)
    editor.current?.setText(next, at)
    setCaret(at)
  }

  /** Empties the box for a send. */
  const take = (): Taken => {
    const prompt = text
    const held = attachments
    setText('')
    editor.current?.setText('')
    // A draft put back after a failed send opens no mention until the caret moves.
    setCaret(null)
    clearDraft(draft)
    setDraftAttachments(draft, [])
    setError(null)
    return { prompt, held }
  }
  /** A failed send's handler: its error, and its message back in the box unless it was refilled. */
  const restore =
    ({ prompt, held }: Taken) =>
    (e: unknown) => {
      setError(errorMessage(e))
      if (!editor.current?.text()) {
        setText(prompt)
        editor.current?.setText(prompt)
      }
      if (held.length > 0) setDraftAttachments(draft, held)
    }

  const onPaste = (event: ClipboardEvent): boolean => {
    const images = event.clipboardData ? pastedImages(event.clipboardData) : []
    if (images.length === 0) return false
    event.preventDefault()
    onActivity?.()
    limitError(attachImages(draft, images))
    return true
  }

  return {
    draft,
    sessionId,
    projectPath,
    disabled,
    text,
    attachments,
    error,
    setError,
    update,
    take,
    restore,
    editor,
    focus: () => editor.current?.focus(),
    changed,
    // For the view.
    slashDismissed,
    setSlashDismissed,
    caret,
    setCaret,
    full,
    pick,
    onPaste,
    onActivity,
    limitError,
  }
}
