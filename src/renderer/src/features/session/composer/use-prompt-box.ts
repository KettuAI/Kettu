import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ATTACHMENT_LIMIT } from '@shared/attachments'
import { putBackDraft } from '@renderer/app/actions'
import { onAppEvent, type AppEvent } from '@renderer/app/events'
import { usePane } from '@renderer/features/split/pane-context'
import { errorMessage } from '@renderer/lib/host'
import { useBrowserStore } from '@renderer/stores/browser'
import {
  selectDraft,
  setDraftAttachments,
  useAttachmentsStore,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import {
  attachBrowserPage,
  attachFiles,
  attachImages,
  attachPastedFiles,
  attachPastedText,
  pastedImages,
  pastedText,
  pasteAsText,
  pickAttachments,
} from './attachments'
import { clearDraft, flushDraft, readDraft, writeDraft } from './drafts'
import type { ComposerEditorHandle } from './editor'
import { useInputHistory } from './use-input-history'

// The state of the box both composers share, the session's and New session's; see PromptBox.

/** What a send takes out of the box, and puts back when it fails. */
export interface Taken {
  prompt: string
  held: DraftAttachment[]
}

export type PromptBoxState = ReturnType<typeof usePromptBox>

/**
 * The box's text and caret, kept outside React state: a key or a caret move renders again only
 * what reads a value it changed, through `useBoxText`.
 */
export class BoxText {
  private readonly listeners = new Set<() => void>()
  constructor(
    public text: string,
    /** The caret, or null while a range is selected, for telling which `@` word it is in. */
    public caret: number | null = null,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(text: string, caret: number | null): void {
    if (text === this.text && caret === this.caret) return
    this.text = text
    this.caret = caret
    for (const listener of this.listeners) listener()
  }
}

/**
 * A value read from the box's text and caret, which renders again only when it changes, so it
 * must be a primitive or otherwise compare equal while it means the same.
 */
export function useBoxText<T>(
  box: { source: BoxText },
  select: (text: string, caret: number | null) => T,
): T {
  const { source } = box
  return useSyncExternalStore(source.subscribe, () => select(source.text, source.caret))
}

/**
 * The box's state, kept in the draft `draft`. `sessionId` is the session whose `insert-into-composer`
 * events it takes besides those for no session; null for New session. While `disabled`, nothing
 * is attached.
 */
export function usePromptBox({
  draft,
  sessionId,
  projectPath,
  hostId,
  disabled,
  onActivity,
}: {
  draft: string
  sessionId: string | null
  projectPath: string | null
  /** The host the message goes to, null for this computer; a host without a project has one too. */
  hostId: string | null
  disabled: boolean
  /** Typing, attaching or focusing the box, as New session's prepared session watches for. */
  onActivity?: () => void
}) {
  const { t } = useTranslation('composer')
  const [source] = useState(() => new BoxText(readDraft(draft)))
  const [error, setError] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const editor = useRef<ComposerEditorHandle>(null)
  const {
    position: historyPosition,
    move: moveHistory,
    close: closeHistory,
    leave: leaveHistory,
  } = useInputHistory({
    sessionId,
    disabled,
    editor,
    // Not written to the draft: the draft stays what it was until the text is edited.
    onRecall: (next) => {
      source.set(next, null)
      editor.current?.setText(next)
      setSlashDismissed(true)
      setError(null)
    },
    onError: () => setError(t('prompt.historyFailed')),
  })
  // Only the focused pane's composer takes the events sent to no session in particular.
  const paneFocused = usePane()?.focused ?? true
  const focused = useRef(paneFocused)
  useEffect(() => {
    focused.current = paneFocused
  }, [paneFocused])
  const attachments = useAttachmentsStore(selectDraft(draft))

  useEffect(() => () => flushDraft(draft), [draft])

  const limitError = (left: number) => setError(left > 0 ? t('attachments.limit') : null)
  // Another host's session takes files and images from this computer as uploads, and no folder.
  const remote = hostId !== null

  // A pick that is still open, or waiting for its grants, makes a second one a no-op.
  const picking = useRef(false)
  const full = attachments.length >= ATTACHMENT_LIMIT
  const pick = (kind: 'files' | 'folder') => {
    if (disabled || picking.current) return
    if (remote && kind === 'folder') {
      setError(t('attachments.folderOtherHost'))
      return
    }
    if (full) {
      setError(t('attachments.limit'))
      return
    }
    picking.current = true
    onActivity?.()
    pickAttachments(draft, kind, projectPath, hostId)
      .then(limitError, (e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        picking.current = false
      })
  }
  // No tile shows until the capture returns, so a second click meanwhile is a no-op.
  const capturing = useRef(false)
  const screenshot = () => {
    if (disabled || !sessionId || capturing.current) return
    if (full) {
      setError(t('attachments.limit'))
      return
    }
    capturing.current = true
    onActivity?.()
    const url = useBrowserStore.getState().bySession[sessionId]?.url ?? null
    attachBrowserPage(draft, sessionId, url, hostId)
      .then(limitError, (e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        capturing.current = false
      })
  }
  const onEvent = useEffectEvent((event: AppEvent) => {
    if (event.kind === 'add-attachments' && focused.current) pick('files')
    if (event.kind === 'drop-attachments' && event.draft === draft && !disabled) {
      onActivity?.()
      attachFiles(draft, event.files, hostId).then(limitError, (e: unknown) =>
        setError(errorMessage(e)),
      )
    }
  })

  /** Adds `added` after what the box holds, on lines of its own. */
  const addText = useCallback(
    (added: string) => {
      const current = editor.current?.text() ?? ''
      const next = current ? `${current.replace(/\s+$/, '')}\n\n${added}` : added
      source.set(next, null)
      writeDraft(draft, next)
      editor.current?.setText(next)
      requestAnimationFrame(() => editor.current?.focus())
    },
    [draft, source],
  )

  /** Puts the command at the start of the text, unless it starts with it already. */
  const addCommand = useCallback(
    (name: string) => {
      const current = editor.current?.text() ?? ''
      const command = `/${name}`
      const has = current.startsWith(command) && /^(\s|$)/.test(current.slice(command.length))
      const next = has ? current : `${command} ${current.trimStart()}`
      source.set(next, null)
      writeDraft(draft, next)
      editor.current?.setText(next)
      requestAnimationFrame(() => editor.current?.focus())
    },
    [draft, source],
  )

  useEffect(
    () =>
      onAppEvent((event) => {
        onEvent(event)
        if (event.kind === 'focus-composer' && focused.current) editor.current?.focus()
        if (event.kind === 'draft-written' && event.draft === draft) {
          closeHistory()
          const next = readDraft(draft)
          source.set(next, null)
          editor.current?.setText(next)
        }
        if (
          event.kind === 'insert-into-composer' &&
          (event.sessionId ? event.sessionId === sessionId : focused.current)
        ) {
          closeHistory()
          addText(event.text)
        }
        if (event.kind === 'command-into-composer' && event.sessionId === sessionId) {
          closeHistory()
          addCommand(event.name)
        }
      }),
    [draft, sessionId, source, closeHistory, addText, addCommand],
  )

  /** Typing changed the text: its state, its draft, and a slash list Esc closed. */
  const changed = (next: string) => {
    closeHistory()
    source.set(next, source.caret)
    writeDraft(draft, next)
    onActivity?.()
    if (!next.startsWith('/')) setSlashDismissed(false)
  }
  /** Puts `next` in the box with the caret at `at`, the end by default. */
  const update = (next: string, at = next.length) => {
    changed(next)
    editor.current?.setText(next, at)
    source.set(next, at)
  }

  /** Empties the box for a send. */
  const take = (): Taken => {
    closeHistory()
    // The editor's own text: keys typed just before the send may not have reached a render.
    const prompt = editor.current?.text() ?? source.text
    const held = attachments
    editor.current?.setText('')
    // A draft put back after a failed send opens no mention until the caret moves.
    source.set('', null)
    clearDraft(draft)
    setDraftAttachments(draft, [])
    setError(null)
    return { prompt, held }
  }
  /** A failed send's handler: its error, and its message back in the draft above what is there. */
  const restore =
    ({ prompt, held }: Taken) =>
    (e: unknown) => {
      setError(errorMessage(e))
      putBackDraft(draft, prompt, held)
    }

  const onPaste = (event: ClipboardEvent): boolean => {
    const data = event.clipboardData
    if (!data) return false
    const files = attachPastedFiles(draft, data, hostId)
    if (files) {
      event.preventDefault()
      onActivity?.()
      files.then(limitError, (e: unknown) => setError(errorMessage(e)))
      return true
    }
    const images = pastedImages(data)
    const long = images.length === 0 ? pastedText(data) : null
    if (images.length === 0 && long === null) return false
    event.preventDefault()
    onActivity?.()
    limitError(
      long === null ? attachImages(draft, images, hostId) : attachPastedText(draft, long, hostId),
    )
    return true
  }

  /** Puts a pasted text back in the box at the caret, in place of its tile. */
  const pasteBack = (key: string, pasted: string) => {
    pasteAsText(draft, key, pasted, (text) => editor.current?.insert(text))
    requestAnimationFrame(() => editor.current?.focus())
  }

  return {
    draft,
    sessionId,
    projectPath,
    disabled,
    source,
    attachments,
    error,
    setError,
    update,
    take,
    restore,
    editor,
    focus: () => editor.current?.focus(),
    changed,
    historyPosition,
    moveHistory,
    leaveHistory,
    // For the view.
    slashDismissed,
    setSlashDismissed,
    setCaret: (caret: number | null) => source.set(source.text, caret),
    full,
    remote,
    pick,
    screenshot,
    onPaste,
    pasteAsText: pasteBack,
    onActivity,
    limitError,
  }
}
