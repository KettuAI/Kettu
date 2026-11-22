// The places in a version that an agent may link to in a reply: a canvas's frames, a document's
// sections and a deck's slides, each with its name and link.

import type { ArtifactChanges } from '@shared/artifact-changes'
import { documentSections, slideTitle } from '@shared/artifact-changes'
import { artifactLink, slidePlace } from '@shared/artifact-links'
import { parseDeck } from '@shared/artifact-slides'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import type { ArtifactStore, FoundVersion } from './store'

/** The most places a result lists; the rest are counted. */
export const PLACES = 100
/** The most a result's text names, for agents whose client shows them only the text. */
const PLACES_IN_TEXT = 20

export interface Place {
  kind: 'frame' | 'section' | 'slide'
  /** A frame with its canvas page's name, such as "Home · Streak card". */
  name: string
  link: string
  /** What a comparison names it by: a frame's id, a section's slug, a slide's number. */
  key: string
}

async function text(
  store: ArtifactStore,
  found: FoundVersion,
  path: string,
): Promise<string | null> {
  const file = found.files.find((f) => f.path === path)
  return file ? (await store.bytes(found, file)).toString('utf8') : null
}

/** Every place of the version, in its order; none for a web page, which is one place. */
export async function placesOf(store: ArtifactStore, found: FoundVersion): Promise<Place[]> {
  const id = found.artifact.id
  try {
    if (found.type?.name === 'document') {
      const markdown = await text(store, found, CONTENT_ENTRIES.document)
      return markdown === null
        ? []
        : documentSections(markdown).flatMap((section) =>
            section.slug === null
              ? []
              : [
                  {
                    kind: 'section' as const,
                    name: section.heading || section.slug,
                    link: artifactLink(id, { kind: 'section', slug: section.slug }),
                    key: section.slug,
                  },
                ],
          )
    }
    if (found.type?.name === 'slides') {
      const json = await text(store, found, CONTENT_ENTRIES.slides)
      const parsed = json === null ? null : parseDeck(json)
      if (!parsed || !('deck' in parsed)) return []
      return parsed.deck.slides.map((slide, i) => {
        const title = slideTitle(slide)
        return {
          kind: 'slide' as const,
          name: title ? `${i + 1}. ${title}` : `Slide ${i + 1}`,
          link: artifactLink(id, slidePlace(i + 1, title)),
          key: String(i + 1),
        }
      })
    }
    const json = await text(store, found, CANVAS_FILE)
    if (json === null) return []
    const doc = parseCanvasDoc(json)
    const sheets = new Map(doc.canvases.map((sheet) => [sheet.id, sheet.name]))
    return doc.pages.map((page) => {
      const sheet = sheets.get(page.canvas)
      return {
        kind: 'frame' as const,
        name: sheet ? `${sheet} · ${page.name}` : page.name,
        link: artifactLink(id, { kind: 'frame', id: page.id }),
        key: page.id,
      }
    })
  } catch {
    // Content that does not read has no places to link; the artifact's own link still works.
    return []
  }
}

/** The places among `places` that `changes` names. */
export function changedPlaces(places: readonly Place[], changes: ArtifactChanges | null): Place[] {
  if (!changes) return []
  const keys = new Set(
    changes.kind === 'frames'
      ? changes.frames.map((frame) => frame.id)
      : changes.kind === 'sections'
        ? changes.sections.flatMap((section) => (section.slug === null ? [] : [section.slug]))
        : changes.kind === 'slides'
          ? changes.slides.map((slide) => String(slide.number))
          : [],
  )
  return places.filter((place) => keys.has(place.key))
}

/** The fields a result carries: the artifact's link, and the places, at most PLACES of them. */
export function placeFields(
  id: string,
  places: readonly Place[],
): { link: string; places: { kind: string; name: string; link: string }[]; places_more: number } {
  return {
    link: artifactLink(id),
    places: places.slice(0, PLACES).map(({ kind, name, link }) => ({ kind, name, link })),
    places_more: Math.max(0, places.length - PLACES),
  }
}

/** A sentence for the result's text with the links, a few places by name. */
export function placesText(id: string, places: readonly Place[], what: string): string {
  const named = places
    .slice(0, PLACES_IN_TEXT)
    .map((place) => `${place.name} ${place.link}`)
    .join('; ')
  const more = places.length > PLACES_IN_TEXT ? `; ${places.length - PLACES_IN_TEXT} more` : ''
  const listed = places.length > 0 ? ` ${what}: ${named}${more}.` : ''
  return ` To point the user at it in a reply, write a Markdown link to ${artifactLink(id)}.${listed}`
}
