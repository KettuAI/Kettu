// Selection-anchored "Add note" toolbar and popover for files opened in the built-in Files panel.
// Reuses the existing selection-quote capability (`file-quote.ts`) so only the anchored passage
// and the user's note are sent to the active agent.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { EditorView } from '@codemirror/view'
import { Cancel01Icon, Comment01Icon, MessageAdd01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { getBuffer, type OpenFile } from '@renderer/stores/files'
import { useSettingsStore } from '@renderer/stores/settings'
import { markNoteRange, type EditorSelectionRange } from './code-note-mark'
import {
  clampRectToBounds,
  isRectVisibleInBounds,
  noteKeyAction,
  type AnchorRect,
  type NoteSendKey,
} from './file-note-model'
import {
  insertFileNoteInComposer,
  sendFileSelectionNote,
  useNoteSendAvailability,
  type NoteDisabledReason,
  type NoteSendAvailability,
} from './file-note-send'
import {
  clipPassageText,
  fileQuote,
  formatPassageLines,
  selectedPassage,
  type FilePassage,
} from './file-quote'
import { FileTypeIcon } from './file-type-icon'
import { quoteInComposer, type MentionMiss } from './mention-lines'

const HIGHLIGHT = 'file-note'

const DISABLED_REASON_KEY = {
  'no-session': 'note.disabled.noSession',
  subagent: 'note.disabled.subagent',
  starting: 'note.disabled.starting',
  'held-outside': 'note.disabled.heldOutside',
  unavailable: 'note.disabled.unavailable',
} as const satisfies Record<NoteDisabledReason, string>

interface FileSelectionSnapshot {
  key: string
  passage: FilePassage
  cmRange: EditorSelectionRange | null
  domRange: Range | null
  rect: AnchorRect
  rootElement: HTMLElement
  contextElement: HTMLElement
}

function toDomRect(rect: AnchorRect): DOMRect {
  const width = Math.max(0, rect.right - rect.left)
  const height = Math.max(0, rect.bottom - rect.top)
  if (typeof DOMRect === 'function') {
    return new DOMRect(rect.left, rect.top, width, height)
  }
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width,
    height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect
}

function editorViewIn(root: HTMLElement | null): EditorView | null {
  const editorEl = root?.querySelector<HTMLElement>('[data-code-editor] .cm-editor')
  return editorEl ? EditorView.findFromDOM(editorEl) : null
}

function editorRangeRect(view: EditorView, range: EditorSelectionRange): AnchorRect | null {
  const bounds = view.scrollDOM.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const start = view.coordsAtPos(range.from, 1)
  const end = view.coordsAtPos(range.to, -1)
  if (!start && !end) return null
  if (start && end) {
    const singleLine = Math.abs(start.top - end.top) < 4
    const raw: AnchorRect = singleLine
      ? {
          left: Math.min(start.left, end.left),
          right: Math.max(start.right, end.right),
          top: Math.min(start.top, end.top),
          bottom: Math.max(start.bottom, end.bottom),
        }
      : {
          left: Math.min(start.left, end.left),
          right: Math.max(start.right, end.right, start.left + 80),
          top: Math.min(start.top, end.top),
          bottom: Math.max(start.bottom, end.bottom),
        }
    return clampRectToBounds(raw, bounds)
  }
  const visible = start ?? end!
  return clampRectToBounds(
    {
      left: visible.left,
      right: Math.max(visible.right, visible.left + 40),
      top: visible.top,
      bottom: visible.bottom,
    },
    bounds,
  )
}

function readSelectionSnapshot(
  root: HTMLElement | null,
  projectPath: string,
  file: OpenFile,
  isRenderedMarkdown: boolean,
  ignorePanelFocus = false,
): FileSelectionSnapshot | null {
  if (!root || file.content?.kind !== 'text') return null
  const body = root.querySelector<HTMLElement>('.kp-doc__body')
  if (!body) return null

  if (!isRenderedMarkdown) {
    if (!ignorePanelFocus && document.activeElement?.closest('.cm-panel')) return null
    const buffer = getBuffer(projectPath, file.path)
    const view = editorViewIn(root)
    if (!buffer || !view) return null
    const { from, to } = view.state.selection.main
    const passage = selectedPassage(view.state.doc, from, to)
    if (!passage) return null
    const cmRange = { from, to }
    const rect = editorRangeRect(view, cmRange)
    if (!rect) return null
    return {
      key: `${from}:${to}:${passage.text}`,
      passage,
      cmRange,
      domRange: null,
      rect,
      rootElement: root,
      // Anchor inside `.cm-scroller` so Floating UI tracks editor scroll automatically.
      contextElement: view.contentDOM,
    }
  }

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!body.contains(range.commonAncestorContainer)) return null
  const text = selection.toString().trim()
  if (!text) return null
  const copy = range.cloneRange()
  const rect = copy.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const node = range.commonAncestorContainer
  const contextElement = (node instanceof HTMLElement ? node : node.parentElement) ?? body
  return {
    key: `md:${text}`,
    passage: { lines: null, text },
    cmRange: null,
    domRange: copy,
    rect: clampRectToBounds(rect, body.getBoundingClientRect()),
    rootElement: root,
    contextElement,
  }
}

function liveRectOf(snapshot: FileSelectionSnapshot): AnchorRect {
  const root = snapshot.rootElement
  const body = root.querySelector<HTMLElement>('.kp-doc__body')
  const bodyBounds = body?.getBoundingClientRect() ?? null

  if (snapshot.cmRange) {
    const view = editorViewIn(root)
    if (view) {
      const measured = editorRangeRect(view, snapshot.cmRange)
      if (measured) {
        snapshot.rect = measured
        return measured
      }
    }
    return bodyBounds ? clampRectToBounds(snapshot.rect, bodyBounds) : snapshot.rect
  }

  if (snapshot.domRange && !snapshot.domRange.collapsed) {
    const rect = snapshot.domRange.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
      snapshot.rect = bodyBounds ? clampRectToBounds(rect, bodyBounds) : rect
    }
  }
  return snapshot.rect
}

function isSelectionVisible(snapshot: FileSelectionSnapshot, root: HTMLElement | null): boolean {
  if (snapshot.cmRange) {
    const view = editorViewIn(root)
    if (!view) return false
    const bounds = view.scrollDOM.getBoundingClientRect()
    const start = view.coordsAtPos(snapshot.cmRange.from, 1)
    const end = view.coordsAtPos(snapshot.cmRange.to, -1)
    if (!start && !end) return false
    const top = Math.min(start?.top ?? Infinity, end?.top ?? Infinity)
    const bottom = Math.max(start?.bottom ?? -Infinity, end?.bottom ?? -Infinity)
    return bottom > bounds.top && top < bounds.bottom
  }
  const scroller = root?.querySelector<HTMLElement>('.kp-doc__body > div')
  if (!scroller || !snapshot.domRange || snapshot.domRange.collapsed) return false
  return isRectVisibleInBounds(
    snapshot.domRange.getBoundingClientRect(),
    scroller.getBoundingClientRect(),
  )
}

export interface FileSelectionNoteCardProps {
  path: string
  passage: FilePassage
  availability: NoteSendAvailability
  sessionId: string | null
  sendKey?: NoteSendKey
  initialNote?: string
  onDraftChange?: (note: string) => void
  onSend: (note: string) => Promise<{ outcome: 'sent' | 'queued' }>
  onToComposer?: ((note: string) => MentionMiss | null) | null
  onClose: () => void
}

/**
 * The selection-anchored note composer card: previews the file path, line range, and selected
 * excerpt before sending, then delivers the note together with the anchored selection.
 */
export function FileSelectionNoteCard({
  path,
  passage,
  availability,
  sessionId,
  sendKey = 'mod-enter',
  initialNote = '',
  onDraftChange,
  onSend,
  onToComposer = null,
  onClose,
}: FileSelectionNoteCardProps) {
  const { t } = useTranslation(['files', 'common'])
  const [note, setNote] = useState(initialNote)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lineBadge = formatPassageLines(passage.lines)
  const previewText = useMemo(() => clipPassageText(passage.text), [passage.text])
  const trimmed = note.trim()
  const canSubmit = availability.canSend && trimmed.length > 0 && !busy
  const sendShortcut = sendKey === 'enter' ? 'Enter' : 'Mod+Enter'

  const updateNote = (next: string) => {
    setNote(next)
    if (error) setError(null)
    onDraftChange?.(next)
  }

  const submit = () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    void onSend(trimmed).then(
      () => {
        setBusy(false)
        setNote('')
        onDraftChange?.('')
        onClose()
      },
      (reason: unknown) => {
        setBusy(false)
        setError(errorMessage(reason))
      },
    )
  }

  const sendToComposer = () => {
    if (!onToComposer || !sessionId || busy) return
    const missed = onToComposer(note)
    if (missed === 'no-composer') {
      setError(t('tree.noComposer'))
      return
    }
    if (missed === 'full') return
    setNote('')
    onDraftChange?.('')
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = noteKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      },
      sendKey,
    )
    if (action === 'close') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (action === 'send') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="flex flex-col gap-2" data-file-note-card="">
      <div className="kp-note-pop__head">
        <div className="kp-note-pop__file" title={path}>
          <FileTypeIcon path={path} className="size-3.5 shrink-0" />
          <span className="kp-note-pop__path" data-file-note-path="">
            {path}
          </span>
        </div>
        <span className="kp-note-pop__lines" data-file-note-lines="">
          {lineBadge ?? t('note.selection')}
        </span>
        <button
          type="button"
          className="kp-note-pop__close"
          aria-label={t('common:actions.close')}
          title={t('common:actions.close')}
          onClick={onClose}
        >
          <PaneIcon icon={Cancel01Icon} size={14} />
        </button>
      </div>

      <pre
        className="kp-note-pop__excerpt"
        aria-label={t('note.excerptLabel')}
        data-file-note-excerpt=""
      >
        <code>{previewText}</code>
      </pre>

      <Textarea
        autoFocus
        rows={3}
        value={note}
        disabled={busy}
        placeholder={t('note.placeholder')}
        aria-label={t('note.placeholder')}
        onChange={(event) => updateNote(event.target.value)}
        onKeyDown={onKeyDown}
        className="kp-note-pop__input"
        data-file-note-input=""
      />

      {error ? (
        <p role="alert" className="kp-note-pop__error" data-file-note-error="">
          {t('note.failed', { error })}
        </p>
      ) : !availability.canSend ? (
        <p className="kp-note-pop__status" data-file-note-disabled="">
          {t(DISABLED_REASON_KEY[availability.reason])}
        </p>
      ) : availability.mode === 'queue' ? (
        <p className="kp-note-pop__status" data-file-note-queued-hint="">
          {t('note.queuedHint')}
        </p>
      ) : null}

      <div className="kp-note-pop__foot">
        {onToComposer && sessionId && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            title={t('note.toComposerTitle')}
            onClick={sendToComposer}
            data-file-note-composer=""
          >
            {t('note.toComposer')}
          </Button>
        )}
        <div className="kp-note-pop__actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onClose}
            data-file-note-cancel=""
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
            data-file-note-send=""
          >
            {busy ? t('note.sending') : t('note.send')}
            {!busy && <kbd className="kp-note-pop__kbd">{formatShortcut(sendShortcut)}</kbd>}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Coordinates selection tracking, the unobtrusive floating pill ("Add note" / "Quote"), selection
 * highlighting while composing, and the anchored note popover inside `FilePreview`.
 */
export function FileSelectionNote({
  root,
  projectPath,
  file,
  isRenderedMarkdown,
  sessionId,
  openNoteRef,
}: {
  root: RefObject<HTMLElement | null>
  projectPath: string
  file: OpenFile
  isRenderedMarkdown: boolean
  sessionId: string | null
  /** Allows the header "Add note" button to open the popover for the active selection. */
  openNoteRef: RefObject<(() => void) | null>
}) {
  const { t } = useTranslation(['files', 'composer'])
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const availability = useNoteSendAvailability(sessionId)

  const [snapshot, setSnapshot] = useState<FileSelectionSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [writing, setWriting] = useState(false)
  const [visible, setVisible] = useState(true)
  const [draft, setDraft] = useState('')

  const writingRef = useRef(false)
  const snapshotRef = useRef<FileSelectionSnapshot | null>(null)
  const draftRef = useRef('')
  const dismissedRef = useRef('')
  const draftForRef = useRef('')
  const openerRef = useRef<HTMLElement | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    writingRef.current = writing
    snapshotRef.current = snapshot
    draftRef.current = draft
  }, [writing, snapshot, draft])

  const close = (keepDraft = false) => {
    setOpen(false)
    setWriting(false)
    if (!keepDraft) {
      setDraft('')
      draftForRef.current = ''
    }
  }

  const openNoteFor = (target: FileSelectionSnapshot | null) => {
    if (!target) return
    dismissedRef.current = ''
    if (draftForRef.current !== target.key) {
      setDraft('')
      draftForRef.current = target.key
    }
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSnapshot(target)
    setVisible(true)
    setOpen(true)
    setWriting(true)
  }

  const openFromHeader = () => {
    const found =
      readSelectionSnapshot(root.current, projectPath, file, isRenderedMarkdown, true) ??
      snapshotRef.current
    openNoteFor(found)
  }

  useEffect(() => {
    openNoteRef.current = openFromHeader
    return () => {
      openNoteRef.current = null
    }
  })

  const quoteSelection = () => {
    const current = snapshotRef.current
    if (!current || !sessionId) return
    const missed = quoteInComposer(sessionId, fileQuote(file.path, current.passage))
    if (missed === 'no-composer') toast(t('tree.noComposer'))
    else if (missed === 'full') toast(t('composer:attachments.limit'))
    else close()
  }

  // Return focus to the editor when the note popover closes, unless the user moved focus elsewhere.
  const returnFocus = () => {
    const back = openerRef.current
    openerRef.current = null
    const active = document.activeElement
    if (active && active !== document.body && !boxRef.current?.contains(active)) return false
    const editor = root.current?.querySelector<HTMLElement>('.cm-content')
    if (editor?.isConnected) return editor
    if (back?.isConnected && back !== document.body) return back
    return false
  }

  // Track selections inside the Files pane without interrupting typing, dragging, or copy/paste.
  useEffect(() => {
    const container = root.current
    if (!container) return
    let frame = 0
    let dragging = false

    const settle = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (writingRef.current || dragging) return
        const found = readSelectionSnapshot(container, projectPath, file, isRenderedMarkdown)
        if (!found) {
          setSnapshot(null)
          setOpen(false)
          return
        }
        if (found.key === dismissedRef.current) return
        setSnapshot(found)
        setVisible(isSelectionVisible(found, container))
        setOpen(true)
      })
    }

    const onPointerDown = (event: PointerEvent) => {
      if (writingRef.current) return
      const target = event.target instanceof Node ? event.target : null
      if (target && boxRef.current?.contains(target)) return
      const body = container.querySelector('.kp-doc__body')
      if (target && body?.contains(target)) {
        dragging = true
        setOpen(false)
      }
    }

    const onPointerUp = () => {
      dragging = false
      settle()
    }

    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') return
      settle()
    }

    const onSelectionChange = () => {
      if (writingRef.current || dragging) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (writingRef.current || dragging) return
        const found = readSelectionSnapshot(container, projectPath, file, isRenderedMarkdown)
        if (!found) {
          dismissedRef.current = ''
          setOpen(false)
          setSnapshot(null)
          return
        }
        if (found.key !== dismissedRef.current) dismissedRef.current = ''
        if (found.key !== snapshotRef.current?.key) {
          setOpen(false)
        }
      })
    }

    // The pill never takes focus, so Esc dismisses it directly until the selection changes.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      if (writingRef.current) return
      if (!snapshotRef.current) return
      dismissedRef.current = snapshotRef.current.key
      setOpen(false)
    }

    const onScroll = () => {
      const current = snapshotRef.current
      if (!current) return
      if (writingRef.current) {
        // Keep the note popover clamped and visible while scrolling through surrounding context.
        setVisible(true)
        return
      }
      setVisible(isSelectionVisible(current, container))
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('keydown', onEscape)
    document.addEventListener('selectionchange', onSelectionChange)
    container.addEventListener('scroll', onScroll, true)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('keydown', onEscape)
      document.removeEventListener('selectionchange', onSelectionChange)
      container.removeEventListener('scroll', onScroll, true)
    }
  }, [root, projectPath, file, isRenderedMarkdown])

  // Keep the selected passage visibly highlighted while focus is inside the note textarea.
  useEffect(() => {
    if (!writing || !snapshot) return
    if (snapshot.cmRange) {
      const view = editorViewIn(snapshot.rootElement)
      if (!view) return
      view.dispatch({ effects: markNoteRange.of(snapshot.cmRange) })
      return () => {
        if (view.dom.isConnected) {
          view.dispatch({ effects: markNoteRange.of(null) })
        }
      }
    }
    if (
      snapshot.domRange &&
      typeof CSS !== 'undefined' &&
      'highlights' in CSS &&
      typeof Highlight !== 'undefined'
    ) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(snapshot.domRange))
      return () => {
        CSS.highlights.delete(HIGHLIGHT)
      }
    }
    return undefined
  }, [writing, snapshot])

  const anchor = useMemo(
    () =>
      snapshot
        ? {
            getBoundingClientRect: () => toDomRect(liveRectOf(snapshot)),
            contextElement: snapshot.contextElement,
          }
        : undefined,
    [snapshot],
  )

  const handleSend = async (noteText: string): Promise<{ outcome: 'sent' | 'queued' }> => {
    if (!sessionId || !snapshot) {
      throw new Error(t('note.disabled.noSession'))
    }
    const result = await sendFileSelectionNote({
      sessionId,
      path: file.path,
      passage: snapshot.passage,
      note: noteText,
      optimistic: availability.canSend && availability.mode === 'send',
    })
    if (result.outcome === 'queued') {
      toast(t('note.queuedToast'))
    }
    return { outcome: result.outcome }
  }

  const handleToComposer = (noteText: string): MentionMiss | null => {
    if (!sessionId || !snapshot) return 'no-composer'
    const missed = insertFileNoteInComposer({
      sessionId,
      path: file.path,
      passage: snapshot.passage,
      note: noteText,
    })
    if (missed === 'full') toast(t('composer:attachments.limit'))
    return missed
  }

  return (
    <Popover
      open={open && snapshot !== null && (writing || visible)}
      onOpenChange={(next, details) => {
        if (next) return
        const away = details.reason === 'outside-press' || details.reason === 'focus-out'
        if (writing && draftRef.current.trim() && away) {
          details.cancel()
          return
        }
        close(writing && details.reason === 'escape-key')
      }}
    >
      <PopoverContent
        ref={boxRef}
        anchor={anchor}
        side="top"
        align="center"
        sideOffset={8}
        initialFocus={false}
        finalFocus={returnFocus}
        className={cn(writing ? 'kp-note-pop' : 'kp-sel-pop w-auto')}
      >
        {writing && snapshot ? (
          <FileSelectionNoteCard
            key={snapshot.key}
            path={file.path}
            passage={snapshot.passage}
            availability={availability}
            sessionId={sessionId}
            sendKey={sendKey}
            initialNote={draft}
            onDraftChange={setDraft}
            onSend={handleSend}
            onToComposer={sessionId ? handleToComposer : null}
            onClose={() => close(false)}
          />
        ) : snapshot ? (
          <div className="kp-sel-pills" data-file-selection-toolbar="">
            <Button
              type="button"
              variant="ghost"
              className="kp-sel-pill"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => openNoteFor(snapshot)}
              data-file-selection-add-note=""
            >
              <PaneIcon icon={Comment01Icon} size={13} />
              {t('preview.addNote')}
            </Button>
            {sessionId && (
              <Button
                type="button"
                variant="ghost"
                className="kp-sel-pill"
                onMouseDown={(event) => event.preventDefault()}
                onClick={quoteSelection}
                data-file-selection-quote=""
              >
                <PaneIcon icon={MessageAdd01Icon} size={13} />
                {t('preview.quoteShort')}
              </Button>
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
