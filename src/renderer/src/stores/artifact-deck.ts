import { keptPerArtifact } from './artifact-kept'

// A deck's place and the speaker notes strip, chosen per artifact and kept on this device, so a
// deck opens again on the slide last seen.

const slides = keptPerArtifact<number>(
  'artifact-deck-slides',
  1,
  (value): value is number => Number.isSafeInteger(value) && (value as number) >= 1,
)

/** The slide last seen, from 1. */
export const useDeckSlide = slides.use
export const setDeckSlide = slides.set

const notes = keptPerArtifact<boolean>(
  'artifact-deck-notes',
  false,
  (value): value is boolean => typeof value === 'boolean',
)

export const useDeckNotes = notes.use
export const setDeckNotes = notes.set
