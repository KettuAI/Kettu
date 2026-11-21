import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { usePane } from '@renderer/features/split/pane-context'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { addComment } from '@renderer/stores/reply-comments'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSideChat } from '@renderer/stores/side-chat'
import { useThreadsStore } from '@renderer/stores/threads'
import { passageOffsets } from './passage-range'

// Painted over the passage while the box has focus, which takes the page's own selection away.
const HIGHLIGHT = 'reply-quote'

/** A passage selected inside one agent message. */
interface Passage {
  text: string
  range: Range
  source: HTMLElement
  /** The message's entry, and where in its text the passage lies. */
  entryId: string
  start: number
  end: number
  /** The range's last rectangle, kept for when a streaming update collapses the range. */
  rect: DOMRect
}

function readSelection(root: HTMLElement): Passage | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const node = range.commonAncestorContainer
  const source = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-agent-message]',
  )
  const entryId = source?.dataset.entryId
  if (!source || !entryId || !root.contains(source)) return null
  const text = selection.toString().trim()
  if (!text) return null
  const copy = range.cloneRange()
  const { start, end } = passageOffsets(source, copy)
  return { text, range: copy, source, entryId, start, end, rect: copy.getBoundingClientRect() }
}

function rectOf(passage: Passage): DOMRect {
  if (!passage.range.collapsed) passage.rect = passage.range.getBoundingClientRect()
  return passage.rect
}

/**
 * A Reply button beside text selected in an agent's message. It opens a box whose comment on the
 * passage joins the composer's comments, which go with the next message. Without `commenting`, as
 * in a session without a composer, only the side chat is offered.
 */
export function ReplyToSelection({
  sessionId,
  agentName,
  content,
  viewport,
  commenting,
}: {
  sessionId: string
  agentName: string
  content: RefObject<HTMLElement | null>
  viewport: RefObject<HTMLElement | null>
  commenting: boolean
}) {
  const { t } = useTranslation('session')
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const paneId = usePane()?.paneId ?? null
  const [passage, setPassage] = useState<Passage | null>(null)
  const [open, setOpen] = useState(false)
  const [writing, setWriting] = useState(false)
  const [visible, setVisible] = useState(true)
  const [answer, setAnswer] = useState('')
  const writingRef = useRef(false)
  const passageRef = useRef<Passage | null>(null)
  // The text of a selection the user closed with Esc, which stays closed until the selection changes.
  const dismissed = useRef('')
  // The passage the written answer is for, which the box shows again when it opens on it.
  const answerFor = useRef('')
  // What had the focus when the box took it, which gets it back as the box closes.
  const opener = useRef<HTMLElement | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    writingRef.current = writing
    passageRef.current = passage
  }, [writing, passage])

  const close = (keepAnswer = false) => {
    setOpen(false)
    setWriting(false)
    if (!keepAnswer) setAnswer('')
  }

  // A sub-agent's page has no side chat.
  const sideOn = useThreadsStore((s) => !!s.replicas[sessionId]?.state?.session.sideChat)
  const askAside = () => {
    if (!passage) return
    const text = passage.text
    window.getSelection()?.removeAllRanges()
    close()
    openSideChat(sessionId, text)
  }

  const startWriting = () => {
    if (!passage) return
    if (answerFor.current !== passage.text) setAnswer('')
    answerFor.current = passage.text
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setWriting(true)
  }

  // The box hands the focus back to what had it, or else to the composer, never to nothing; a
  // focus the user moved elsewhere stays there, and the Reply button alone never took it.
  const returnFocus = () => {
    const back = opener.current
    opener.current = null
    const at = document.activeElement
    if (!back || (at && at !== document.body && !box.current?.contains(at))) return false
    if (back.isConnected && back !== document.body) return back
    emitAppEvent({ kind: 'focus-composer' })
    return false
  }

  // A selection settles when the pointer is released or a key is, and goes with any change of it.
  useEffect(() => {
    const root = content.current
    if (!root) return
    let frame = 0
    const settle = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (writingRef.current) return
        const found = readSelection(root)
        if (found?.text === dismissed.current) return
        setPassage(found)
        setOpen(found !== null)
      })
    }
    const changed = () => {
      if (writingRef.current) return
      const text = window.getSelection()?.toString().trim()
      if (text !== dismissed.current) dismissed.current = ''
      if (text !== passageRef.current?.text) setOpen(false)
    }
    // The button never takes focus, so the popover's own Esc handling does not see the key.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || writingRef.current) return
      dismissed.current = passageRef.current?.text ?? ''
      setOpen(false)
    }
    document.addEventListener('pointerup', settle)
    document.addEventListener('keyup', settle)
    document.addEventListener('keydown', escape)
    document.addEventListener('selectionchange', changed)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerup', settle)
      document.removeEventListener('keyup', settle)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('selectionchange', changed)
    }
  }, [content])

  useEffect(() => {
    if (!writing || !passage) return
    CSS.highlights.set(HIGHLIGHT, new Highlight(passage.range))
    return () => {
      CSS.highlights.delete(HIGHLIGHT)
    }
  }, [writing, passage])

  // Out of the thread's view the box hides, with what was typed in it kept.
  useEffect(() => {
    const scroller = viewport.current
    if (!passage || !scroller) return
    const check = () => {
      const bounds = scroller.getBoundingClientRect()
      const rect = rectOf(passage)
      setVisible(rect.bottom > bounds.top && rect.top < bounds.bottom)
    }
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    return () => scroller.removeEventListener('scroll', check)
  }, [passage, viewport])

  const anchor = useMemo(
    () =>
      passage && {
        getBoundingClientRect: () => rectOf(passage),
        contextElement: passage.source,
      },
    [passage],
  )

  /** Adds the comment to the composer's, and with `now` sends them with its text at once. */
  const add = (now: boolean) => {
    const comment = answer.trim()
    if (!passage || !comment) return
    addComment(sessionId, {
      id: crypto.randomUUID(),
      entryId: passage.entryId,
      passage: passage.text,
      start: passage.start,
      end: passage.end,
      comment,
    })
    answerFor.current = ''
    window.getSelection()?.removeAllRanges()
    close()
    if (now) emitAppEvent({ kind: 'send-composer', sessionId, paneId })
  }

  // The send key adds; with Mod, and with Shift too when Mod+Enter is the send key, it also sends.
  const addKey = sendKey === 'enter' ? 'Enter' : 'Mod+Enter'
  const sendKeys = sendKey === 'enter' ? 'Mod+Enter' : 'Mod+Shift+Enter'
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    const now =
      sendKey === 'enter' ? isMod(event) && !event.shiftKey : isMod(event) && event.shiftKey
    const adds =
      sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event) && !event.shiftKey
    if (!now && !adds) return
    event.preventDefault()
    add(now)
  }

  return (
    <Popover
      open={open && (writing || visible) && (commenting || sideOn)}
      onOpenChange={(next, details) => {
        if (next) return
        // A click elsewhere must not lose what was typed, and Esc keeps it for the same passage.
        const away = details.reason === 'outside-press' || details.reason === 'focus-out'
        if (writing && answer.trim() && away) {
          details.cancel()
          return
        }
        close(writing && details.reason === 'escape-key')
      }}
    >
      <PopoverContent
        ref={box}
        anchor={anchor}
        side="top"
        align="center"
        sideOffset={6}
        initialFocus={false}
        finalFocus={returnFocus}
        className={cn(
          writing ? 'w-80 gap-2 p-3' : 'ks-reply-pop w-auto',
          writing && !visible && 'invisible',
        )}
      >
        {writing && passage ? (
          <>
            <blockquote
              aria-label={t('reply.quote')}
              className="line-clamp-2 border-l-2 border-strong pl-2.5 text-small text-secondary"
            >
              {passage.text}
            </blockquote>
            <div className="flex items-end gap-2">
              <Textarea
                autoFocus
                rows={1}
                value={answer}
                placeholder={t('reply.placeholder', { agent: agentName })}
                aria-label={t('reply.placeholder', { agent: agentName })}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={onKeyDown}
                className="max-h-32 min-h-8 flex-1 resize-none border-transparent bg-transparent px-0 py-1.5 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:shadow-none"
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      disabled={!answer.trim()}
                      onClick={() => add(false)}
                      className="shrink-0"
                    />
                  }
                >
                  {t('reply.add')}
                </TooltipTrigger>
                <TooltipContent>
                  {t('reply.addKeys', {
                    add: formatShortcut(addKey),
                    send: formatShortcut(sendKeys),
                  })}
                </TooltipContent>
              </Tooltip>
            </div>
          </>
        ) : (
          <div className="ks-reply-pills">
            {commenting && (
              <Button
                variant="ghost"
                className="ks-reply-pill"
                // The click must not take focus, which would drop the selection it quotes.
                onMouseDown={(event) => event.preventDefault()}
                onClick={startWriting}
              >
                {t('reply.button')}
              </Button>
            )}
            {sideOn && (
              <Button
                variant="ghost"
                className="ks-reply-pill"
                onMouseDown={(event) => event.preventDefault()}
                onClick={askAside}
              >
                {t('reply.side')}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
