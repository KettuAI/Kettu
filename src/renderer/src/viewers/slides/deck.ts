// The deck as the viewer works on it: its colors on a slide, and the user's edits of its text.

import type { CSSProperties } from 'react'
import { DECK_PALETTES, type Deck } from '@shared/artifact-slides'

/** Where a text lies in the deck, as the keys and indexes that lead to it. */
export type TextPath = (string | number)[]

/** The deck's colors as the slide's custom properties, from the format's own palette. */
export function deckStyle(deck: Deck): CSSProperties {
  const palette = DECK_PALETTES[deck.theme ?? 'light']
  return {
    '--slide-background': palette.background,
    '--slide-text': palette.text,
    '--slide-muted': palette.muted,
    '--slide-accent': palette.accent,
    '--slide-surface': palette.surface,
    '--slide-line': palette.line,
  } as CSSProperties
}

/** The deck with the text at `path` replaced. */
export function withText(deck: Deck, path: TextPath, text: string): Deck {
  const copy = structuredClone(deck) as unknown as Record<string | number, unknown>
  let at = copy
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>
  at[path.at(-1)!] = text
  return copy as unknown as Deck
}
