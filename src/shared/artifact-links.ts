// Links to an artifact and to a place in it, which the artifact tools give an agent to write in a
// reply: `kettu://artifact/<id>`, then `/frame/<id>` for a canvas frame, `/section/<slug>` for a
// document's section, or `/slide/<number>-<slug>` for a slide. A frame's id never changes, a
// section is named by its heading and a slide by its title as well as its place, so a link written
// against one version still finds its place in a later one. Everything needed to tell where a link
// goes is in it, so a thread resolves it without asking the host.

export const ARTIFACT_LINK_PREFIX = 'kettu://artifact/'

export type ArtifactPlace =
  | { kind: 'frame'; id: string }
  | { kind: 'section'; slug: string }
  /** `slug` is the title's when the slide had one. */
  | { kind: 'slide'; number: number; slug: string | null }

/** Where a link goes: the artifact, and the place in it, null for the whole of it. */
export interface ArtifactLocation {
  artifactId: string
  place: ArtifactPlace | null
}

const ID = /^art_[0-9A-HJKMNP-TV-Z]{26}$/
const FRAME = /^[A-Za-z0-9_-]{1,64}$/
const SLUG_CHARS = 120
const MAX_SLIDE = 10_000

/**
 * A heading's or a title's slug: its words in lower case joined by hyphens, letters and digits of
 * any script kept and other marks dropped; "section" when nothing is left.
 */
export function headingSlug(heading: string): string {
  const slug = Array.from(
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/[\s-]+/g, '-'),
  )
    .slice(0, SLUG_CHARS)
    .join('')
    .replace(/-+$/, '')
  return slug === '' ? 'section' : slug
}

function isSlug(value: string): boolean {
  return value !== '' && Array.from(value).length <= SLUG_CHARS && /^[\p{L}\p{N}_-]+$/u.test(value)
}

/** The link to an artifact, or to a place in it. */
export function artifactLink(artifactId: string, place: ArtifactPlace | null = null): string {
  const base = `${ARTIFACT_LINK_PREFIX}${artifactId}`
  if (!place) return base
  switch (place.kind) {
    case 'frame':
      return `${base}/frame/${place.id}`
    case 'section':
      return `${base}/section/${encodeURIComponent(place.slug)}`
    case 'slide':
      return `${base}/slide/${place.number}${place.slug ? `-${encodeURIComponent(place.slug)}` : ''}`
  }
}

/** Where a link goes, or null for anything that is not a link to an artifact. */
export function parseArtifactLink(href: string): ArtifactLocation | null {
  if (!href.startsWith(ARTIFACT_LINK_PREFIX)) return null
  const parts = href.slice(ARTIFACT_LINK_PREFIX.length).split('/')
  const artifactId = parts[0] ?? ''
  if (!ID.test(artifactId)) return null
  if (parts.length === 1) return { artifactId, place: null }
  if (parts.length !== 3) return null
  let value: string
  try {
    value = decodeURIComponent(parts[2]!)
  } catch {
    return null
  }
  switch (parts[1]) {
    case 'frame':
      return FRAME.test(value) ? { artifactId, place: { kind: 'frame', id: value } } : null
    case 'section':
      return isSlug(value) ? { artifactId, place: { kind: 'section', slug: value } } : null
    case 'slide': {
      const match = /^([1-9][0-9]{0,4})(?:-(.+))?$/u.exec(value)
      if (!match) return null
      const number = Number(match[1])
      const slug = match[2] ?? null
      if (number > MAX_SLIDE || (slug !== null && !isSlug(slug))) return null
      return { artifactId, place: { kind: 'slide', number, slug } }
    }
    default:
      return null
  }
}

/** What a version holds that links name: its frames, its sections or its slides, in order. */
export interface ArtifactOutline {
  frames?: readonly { id: string; name: string }[]
  sections?: readonly { slug: string | null; heading: string | null }[]
  /** From 1. */
  slides?: readonly { number: number; title: string | null }[]
}

/** A place found in a version: what it is called there, and a slide's number in it. */
export type ResolvedPlace =
  | { kind: 'frame'; id: string; name: string }
  | { kind: 'section'; slug: string; heading: string | null }
  | { kind: 'slide'; number: number; title: string | null }

/**
 * The place a link names in a version, by what it holds: a frame by its id, a section by its slug,
 * a slide by its title's slug first, the nearest to its number when several share it, else by its
 * number. Null when the version no longer has it, and the link then opens the artifact.
 */
export function resolvePlace(place: ArtifactPlace, outline: ArtifactOutline): ResolvedPlace | null {
  switch (place.kind) {
    case 'frame': {
      const frame = outline.frames?.find((f) => f.id === place.id)
      return frame ? { kind: 'frame', id: frame.id, name: frame.name } : null
    }
    case 'section': {
      const section = outline.sections?.find((s) => s.slug === place.slug)
      return section ? { kind: 'section', slug: place.slug, heading: section.heading } : null
    }
    case 'slide': {
      const slides = outline.slides ?? []
      const titled =
        place.slug === null
          ? []
          : slides.filter((s) => s.title !== null && headingSlug(s.title) === place.slug)
      const near = titled.toSorted(
        (a, b) => Math.abs(a.number - place.number) - Math.abs(b.number - place.number),
      )[0]
      const slide = near ?? slides.find((s) => s.number === place.number)
      return slide ? { kind: 'slide', number: slide.number, title: slide.title } : null
    }
  }
}

/** A slide's place for a link: its number, with its title's slug when it has a title. */
export function slidePlace(number: number, title: string | null): ArtifactPlace {
  return { kind: 'slide', number, slug: title ? headingSlug(title) : null }
}
