import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react'
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
  const pendingCaret = useRef<number | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
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
        if (event.kind === 'focus-composer') textarea.current?.focus()
        if (
          event.kind === 'insert-into-composer' &&
          (!event.sessionId || event.sessionId === sessionId)
        ) {
          setText((current) => {
            const next = current ? `${current.replace(/\s+$/, '')}\n\n${event.text}` : event.text
            writeDraft(draft, next)
            return next
          })
          requestAnimationFrame(() => {
            const el = textarea.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }
      }),
    [draft, sessionId],
  )

  // A chosen mention or `@` from the menu puts the caret after what it wrote.
  useLayoutEffect(() => {
    const at = pendingCaret.current
    const el = textarea.current
    if (at === null || !el) return
    pendingCaret.current = null
    el.setSelectionRange(at, at)
  }, [text])

  // A textarea scrolls only the caret into view, not its padding, so typing at the end of a long
  // draft would leave the last line on the box's edge.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el || document.activeElement !== el || el.selectionEnd !== el.value.length) return
    if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
  }, [text])

  const update = (next: string, at?: number) => {
    setText(next)
    writeDraft(draft, next)
    onActivity?.()
    if (!next.startsWith('/')) setSlashDismissed(false)
    if (at !== undefined) {
      pendingCaret.current = at
      setCaret(at)
      return
    }
    const el = textarea.current
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  /** Empties the box for a send. */
  const take = (): Taken => {
    const prompt = text
    const held = attachments
    setText('')
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
      setText((current) => (current ? current : prompt))
      if (held.length > 0) setDraftAttachments(draft, held)
    }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = pastedImages(event.clipboardData)
    if (images.length === 0) return
    event.preventDefault()
    onActivity?.()
    limitError(attachImages(draft, images))
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
    textarea,
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
