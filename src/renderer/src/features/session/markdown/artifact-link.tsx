import { useContext, useEffect, useState, type ReactNode } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { resolvePlace, type ArtifactLocation } from '@shared/artifact-links'
import type { ThumbnailPart } from '@shared/artifacts'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { usePartThumbnails } from '@renderer/features/artifacts/artifact-host'
import { KIND_ICON } from '@renderer/features/artifacts/kinds'
import { artifactKind, type ArtifactKind } from '@renderer/features/artifacts/model'
import { landingPlace } from '@renderer/features/artifacts/change-walk'
import { readPlaceOutline, usePlaceOutline } from '@renderer/features/artifacts/place-outline'
import { usePartThumbnail, useThumbnail } from '@renderer/features/artifacts/thumbnails'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { learnArtifactHost, sessionHost } from '@renderer/lib/host'
import { landArtifact } from '@renderer/stores/artifact-walk'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { MAIN_ARTIFACT_PANEL, openArtifact, openArtifactTab } from '@renderer/stores/view'

/** The kind a place belongs to, for a link whose artifact is not listed. */
const PLACE_KIND = { frame: 'canvas', section: 'document', slide: 'slides' } as const

/**
 * A link in a reply to an artifact or a place in it, drawn like a file reference: the kind's icon
 * and the name over the link's line, with a card of the place on hover. A click opens it beside the
 * thread, lands on the place and flashes it. A link to an artifact or a place that is gone still
 * reads, and says so.
 */
export function ArtifactLink({
  location,
  children,
}: {
  location: ArtifactLocation
  children: ReactNode
}) {
  const { t } = useTranslation('artifacts')
  const sessionId = useContext(SessionIdContext)
  const { artifactId, place } = location
  if (sessionId) learnArtifactHost(artifactId, sessionHost(sessionId))
  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])
  const summary = useArtifactsStore(
    (s) =>
      s.list?.find((a) => a.id === artifactId) ??
      s.deleted?.find((a) => a.id === artifactId) ??
      null,
  )
  const erased = useArtifactsStore((s) => artifactStanding(s, artifactId) === 'erased')
  const kind: ArtifactKind | null = summary
    ? artifactKind(summary)
    : place
      ? PLACE_KIND[place.kind]
      : null
  const [hovered, setHovered] = useState(false)
  const outlineKind = kind === 'canvas' || kind === 'document' || kind === 'slides' ? kind : null
  const outline = usePlaceOutline(
    artifactId,
    summary?.version ?? null,
    place ? outlineKind : null,
    hovered && !!summary && !!place,
  )
  const resolved = place && outline ? resolvePlace(place, outline) : null
  const placeGone = !!place && outline !== undefined && outline !== null && resolved === null

  const open = (): void => {
    if (erased) return
    const panel = sessionId ?? MAIN_ARTIFACT_PANEL
    if (sessionId) openArtifactTab(sessionId, artifactId, { preview: true })
    else openArtifact(artifactId)
    if (place?.kind !== 'slide' || place.slug === null || !summary) {
      landArtifact(panel, artifactId, { place })
      return
    }
    // A slide is found by its title in the version shown, as the hover card names it.
    void readPlaceOutline(artifactId, summary.version, 'slides').then((read) =>
      landArtifact(panel, artifactId, { place: landingPlace(place, read) }),
    )
  }

  const name =
    resolved?.kind === 'frame'
      ? resolved.name
      : resolved?.kind === 'section'
        ? resolved.heading
        : resolved?.kind === 'slide'
          ? (resolved.title ?? t('link.slide', { number: resolved.number }))
          : null
  const state = erased
    ? t('link.erased')
    : summary?.deletedAt != null
      ? t('link.deleted')
      : placeGone
        ? t('link.placeGone')
        : null

  const icon = kind ? KIND_ICON[kind] : KIND_ICON.web
  return (
    <HoverCard onOpenChange={setHovered}>
      <HoverCardTrigger
        delay={400}
        render={
          <button
            type="button"
            data-artifact-ref=""
            data-gone={erased || summary?.deletedAt != null || placeGone || undefined}
            aria-disabled={erased || undefined}
            onClick={open}
            className="select-auto text-left data-[gone]:opacity-70 aria-disabled:cursor-default"
          />
        }
      >
        <span className="thread-link">
          <HugeiconsIcon
            icon={icon}
            strokeWidth={1.9}
            aria-hidden
            className="relative -top-[1.5px] mr-1 inline-block size-[15px] align-middle text-secondary"
          />
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="grid w-64 gap-1 p-3">
        <PlacePreview
          id={artifactId}
          version={summary?.version ?? null}
          place={resolved}
          kind={kind}
          shown={hovered && !erased}
        />
        <b className="truncate text-sm font-medium text-foreground">
          {name ?? summary?.title ?? children}
        </b>
        <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{summary?.title ?? t('link.unknown')}</span>
          {summary && (
            <span className="flex-none">{t('pages.version', { version: summary.version })}</span>
          )}
        </span>
        {state && <span className="text-xs text-muted-foreground">{state}</span>}
      </HoverCardContent>
    </HoverCard>
  )
}

/** The place's own picture where the host draws one, else the artifact's. */
function PlacePreview({
  id,
  version,
  place,
  kind,
  shown,
}: {
  id: string
  version: number | null
  place: ReturnType<typeof resolvePlace>
  kind: ArtifactKind | null
  shown: boolean
}) {
  const parts = usePartThumbnails(id)
  const part: ThumbnailPart | null =
    place?.kind === 'frame'
      ? { frame: place.id }
      : place?.kind === 'slide'
        ? { slide: place.number }
        : null
  const own = usePartThumbnail(
    id,
    version ?? 0,
    part ?? { slide: 1 },
    shown && parts && part !== null && version !== null,
  )
  const whole = useThumbnail(
    { id, version: version ?? 0, pages: 0, canvas: kind === 'canvas' },
    shown && version !== null && !(parts && part),
  )
  const picture = parts && part ? own : whole
  if (version === null || picture.state === 'failed') return null
  return (
    <span className="mb-1 block aspect-[16/10] overflow-hidden rounded-md bg-muted ring-1 ring-border">
      {picture.state === 'ready' && (
        <img
          src={picture.src}
          alt=""
          draggable={false}
          className="size-full object-cover object-top"
        />
      )}
    </span>
  )
}
