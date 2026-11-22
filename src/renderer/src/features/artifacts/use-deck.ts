// A deck's version as the window lays it out: how many slides, their size and colors, and each
// slide's title and notes, read from the host and parsed by the format's own checks. Kept by
// version, since a version never changes; the slides themselves are drawn only in the page.

import { useEffect, useState } from 'react'
import { DECK_PALETTES, parseDeck, slideSize, type Deck, type Slide } from '@shared/artifact-slides'
import type { CommentAnchor } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { snippet } from '@shared/artifact-runtime/page-messages'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'

export interface DeckSlide {
  /** From 1, as links and the host's thumbnails number them. */
  number: number
  title: string | null
  notes: string
}

export interface DeckOutline {
  version: number
  width: number
  height: number
  palette: (typeof DECK_PALETTES)[keyof typeof DECK_PALETTES]
  slides: DeckSlide[]
}

/** A slide's title as the Slides card and the Grid name it: its title, or its first words. */
function titleOf(slide: Slide): string | null {
  const words =
    'title' in slide && slide.title ? slide.title : slide.layout === 'quote' ? slide.quote : null
  const line = words?.replace(/\s+/g, ' ').trim()
  return line ? line : null
}

function outlineOf(version: number, deck: Deck): DeckOutline {
  const size = slideSize(deck.aspect)
  return {
    version,
    width: size.width,
    height: size.height,
    palette: DECK_PALETTES[deck.theme ?? 'light'],
    slides: deck.slides.map((slide, i) => ({
      number: i + 1,
      title: titleOf(slide),
      notes: slide.notes ?? '',
    })),
  }
}

const KEPT = 40
const read = new Map<string, Promise<DeckOutline | null>>()

function readDeck(id: string, version: number): Promise<DeckOutline | null> {
  const key = `${id}:${version}`
  let found = read.get(key)
  if (!found) {
    found = host('artifacts.file', { id, version, path: CONTENT_ENTRIES.slides }).then(
      ({ bytes }) => {
        const parsed = parseDeck(new TextDecoder().decode(bytes))
        return 'deck' in parsed ? outlineOf(version, parsed.deck) : null
      },
      () => {
        read.delete(key)
        return null
      },
    )
    read.set(key, found)
    if (read.size > KEPT) read.delete(read.keys().next().value!)
  }
  return found
}

/**
 * The deck of `version`, read once it is asked for: the last one read stays while the next loads,
 * so a new version changes nothing on screen until it is in; null when it cannot be read.
 */
export function useDeck(id: string, version: number | null): DeckOutline | null | undefined {
  const [deck, setDeck] = useState<DeckOutline | null | undefined>(undefined)
  useEffect(() => {
    if (version === null) return
    let live = true
    void readDeck(id, version).then((outline) => {
      if (live) setDeck((was) => outline ?? was ?? null)
    })
    return () => {
      live = false
    }
  }, [id, version])
  return deck
}

/** A slide's title, or "Slide 3" for one without. */
export function slideName(slide: DeckSlide): string {
  return slide.title ?? i18n.t('artifacts:deck.slide', { number: slide.number })
}

/** A slide's anchor: the slide itself, or an element on it by its tag and words. */
export function slideAnchor(
  version: number,
  slide: number,
  name: string | null,
  element: { tag: string; text: string } | null,
): CommentAnchor {
  return {
    version,
    path: ARTIFACT_ENTRY,
    page: { number: slide, name },
    offset: null,
    tag: element?.tag ?? null,
    text: element ? snippet(element.text) : '',
    missing: false,
  }
}
