import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft01Icon, ArrowRight01Icon, Presentation01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { parseDeck, slideSize, type Deck } from '@shared/artifact-slides'
import type { ViewerConfig, ViewerView } from '@shared/artifact-types'
import { Button } from '@renderer/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { markReady, readSlide, remembered } from '../common/boot'
import { EditBar, EditButton, SaveNotice } from '../common/content'
import { useContent } from '../common/use-content'
import { deckStyle, withText, type TextPath } from './deck'
import { DrivenDeck } from './driven-deck'
import { SlideView } from './slide'
import { Stage } from './stage'
import { useDrive, type DeckAsk } from './use-drive'

const REMEMBERED = 'kettu-slide'

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA')
  )
}

/**
 * A deck in the artifact viewer is driven by the window, which draws everything around the slide;
 * anywhere else, as in a copy, the viewer is a small player of its own. A page in a frame waits a
 * moment for the window to drive it before it shows the player.
 */
export function SlidesViewer({ config, view }: { config: ViewerConfig; view: ViewerView }) {
  const asks = useRef<(ask: DeckAsk) => void>(() => {})
  const state = useDrive((ask) => asks.current(ask))
  const framed = window.parent !== window && view === 'normal'
  const [waited, setWaited] = useState(!framed)
  useEffect(() => {
    if (waited) return
    const timer = setTimeout(() => setWaited(true), DRIVE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [waited])
  if (state && view === 'normal') return <DrivenDeck config={config} state={state} asksRef={asks} />
  if (!waited) return null
  return <PlayerDeck config={config} view={view} />
}

/** How long a deck in a frame waits to be driven before it shows its own player. */
const DRIVE_WAIT_MS = 800

function PlayerDeck({ config, view }: { config: ViewerConfig; view: ViewerView }) {
  const { t } = useTranslation('viewers')
  const content = useContent(config)
  const parsed = useMemo(
    () => (content.text === null ? null : parseDeck(content.text)),
    [content.text],
  )
  const [draft, setDraft] = useState<Deck | null>(null)
  // Counts a text being typed as a change, so Save is enabled before the text is taken on blur.
  const [typing, setTyping] = useState(false)
  const [index, setIndex] = useState(() => Number(remembered.get(REMEMBERED)) || 0)
  const [presenting, setPresenting] = useState(false)
  const deck = draft ?? (parsed && 'deck' in parsed ? parsed.deck : null)
  const count = deck?.slides.length ?? 0
  const at = Math.min(index, Math.max(0, count - 1))
  const editing = draft !== null
  const size = slideSize(deck?.aspect)

  useEffect(() => remembered.set(REMEMBERED, String(at)), [at])

  useEffect(() => {
    if (view !== 'normal') return
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp'
            ? -1
            : event.key === ' '
              ? event.shiftKey
                ? -1
                : 1
              : 0
      if (step !== 0) {
        event.preventDefault()
        setIndex(Math.max(0, Math.min(count - 1, at + step)))
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        setIndex(event.key === 'Home' ? 0 : count - 1)
      } else if (event.key === 'Escape' && presenting) {
        event.preventDefault()
        setPresenting(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, count, at, presenting])

  useLayoutEffect(() => {
    if (view !== 'print' || !deck) return
    void markReady()
  }, [view, deck])

  if (content.failed || (parsed && 'problems' in parsed)) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyDescription>
            {parsed && 'problems' in parsed
              ? t('load.invalid', { reason: parsed.problems.join(' ') })
              : t('load.failed')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!deck) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  const editor = editing
    ? {
        input: () => setTyping(true),
        leave: (path: TextPath, text: string) => {
          setTyping(false)
          setDraft(withText(deck, path, text))
        },
      }
    : null
  const slide = (i: number) => (
    <SlideView
      slide={deck.slides[i]!}
      index={i}
      editing={editor}
      label={t('slides.slide', { number: i + 1 })}
    />
  )

  if (view === 'print') {
    return (
      <div style={deckStyle(deck)}>
        <style>{`@page { size: ${size.width}px ${size.height}px; margin: 0 }`}</style>
        {deck.slides.map((_, i) => (
          <div key={i} className="slide-print" style={{ width: size.width, height: size.height }}>
            {slide(i)}
          </div>
        ))}
      </div>
    )
  }

  if (view === 'thumbnail') {
    const shown = Math.min(count, readSlide() ?? 1) - 1
    return (
      <div className="flex h-full bg-(--slide-background)" style={deckStyle(deck)}>
        <Stage size={size}>{slide(shown)}</Stage>
      </div>
    )
  }

  const nav = (
    <div className="flex items-center gap-1">
      <Button
        variant="quiet"
        size="icon"
        aria-label={t('slides.previous')}
        disabled={at === 0}
        onClick={() => setIndex(at - 1)}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.9} aria-hidden />
      </Button>
      <span className="min-w-14 text-center text-ui text-secondary tabular-nums">
        {t('slides.counter', { number: at + 1, count })}
      </span>
      <Button
        variant="quiet"
        size="icon"
        aria-label={t('slides.next')}
        disabled={at === count - 1}
        onClick={() => setIndex(at + 1)}
      >
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={1.9} aria-hidden />
      </Button>
    </div>
  )

  if (presenting) {
    return (
      <div className="flex h-full flex-col bg-background" style={deckStyle(deck)}>
        <Stage size={size}>{slide(at)}</Stage>
        <div className="absolute inset-x-0 bottom-4 mx-auto flex w-max items-center gap-3 rounded-xl bg-popover/85 py-1 pr-3.5 pl-1 shadow-menu backdrop-blur">
          {nav}
          <span className="text-ui text-tertiary">{t('slides.exit')}</span>
        </div>
      </div>
    )
  }

  return (
    <main className="flex h-full flex-col bg-background" style={deckStyle(deck)}>
      {content.head !== null && !editing && <EditButton onClick={() => setDraft(deck)} />}
      <Stage size={size} framed className={cn('p-6', editing ? 'pb-28' : 'pb-18')}>
        {slide(at)}
      </Stage>
      <div className="fixed inset-x-0 bottom-4 z-10 mx-auto flex w-max items-center gap-2 rounded-xl bg-popover py-1 pr-1 pl-1 shadow-menu">
        {nav}
        <Button variant="ghost" size="compact" onClick={() => setPresenting(true)}>
          <HugeiconsIcon icon={Presentation01Icon} strokeWidth={1.9} aria-hidden />
          {t('slides.present')}
        </Button>
      </div>
      {editing && content.head !== null && (
        <EditBar
          hint={t('slides.editHint')}
          dirty={
            typing ||
            JSON.stringify(draft) !==
              JSON.stringify(parsed && 'deck' in parsed ? parsed.deck : null)
          }
          head={content.head}
          status={content.status}
          className="bottom-16"
          onDiscard={() => setDraft(null)}
          onSave={() => {
            const next = `${JSON.stringify(draft, null, 2)}\n`
            void content.save(next).then((saved) => saved && setDraft(null))
          }}
        />
      )}
      <SaveNotice status={content.status} onDismiss={content.dismiss} />
    </main>
  )
}
