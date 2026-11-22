import { useMemo } from 'react'
import { PresentFrame } from './canvas-present'
import { PresentStage, type PresentSheet } from './present-stage'
import { SlideThumb } from './slides-card'
import { pageUrl } from './use-artifact'
import { slideName, type DeckOutline } from './use-deck'

/**
 * Presenting a deck from `start`, a slide from 1: the same stage a canvas presents on, one slide at
 * a time on a dark ground, each drawn by the deck's own viewer at the slide's size. Notes never
 * show here.
 */
export function DeckPresent({
  artifactId,
  url,
  deck,
  title,
  start,
  onExit,
}: {
  artifactId: string
  url: string
  deck: DeckOutline
  title: string
  start: number
  onExit: (last: number) => void
}) {
  const sheets = useMemo<PresentSheet[]>(
    () =>
      deck.slides.map((slide) => ({
        key: String(slide.number),
        width: deck.width,
        height: deck.height,
        name: slideName(slide),
        group: '',
        groupName: '',
      })),
    [deck],
  )
  // The version's own page, which shows one slide filling the frame.
  const page = pageUrl(url, deck.version)
  return (
    <PresentStage
      title={title}
      sheets={sheets}
      start={String(start)}
      onExit={(last) => onExit(Number(last) || start)}
      renderSheet={(sheet, onKey) => (
        <PresentFrame
          origin={url.slice(0, -1)}
          src={`${page}?view=thumbnail&slide=${sheet.key}`}
          title={sheet.name}
          onKey={onKey}
        />
      )}
      renderThumb={(sheet) => {
        const slide = deck.slides[Number(sheet.key) - 1]
        return slide ? <SlideThumb artifactId={artifactId} deck={deck} slide={slide} /> : null
      }}
    />
  )
}
