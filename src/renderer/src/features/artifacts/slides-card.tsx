import { useEffect, useRef, type CSSProperties } from 'react'
import { Comment01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { useHostHas } from '@renderer/lib/host-features'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { setViewerState, useViewerState, type PagesFilter } from '@renderer/stores/artifact-viewer'
import { usePartThumbnail } from './thumbnails'
import { slideName, type DeckOutline, type DeckSlide } from './use-deck'
import { useInView } from './use-in-view'
import { ViewerSlot } from './viewer-shell'
import { NoneHere } from './viewer-states'

/**
 * A slide's picture as the host draws it; where it draws none, or until it has, the slide's title
 * on the deck's own colors, so a deck on any host has something to find a slide by.
 */
export function SlideThumb({
  artifactId,
  deck,
  slide,
}: {
  artifactId: string
  deck: DeckOutline
  slide: DeckSlide
}) {
  const box = useRef<HTMLSpanElement>(null)
  const inView = useInView(box)
  const pictures = useHostHas('partThumbnails') === true
  const thumbnail = usePartThumbnail(
    artifactId,
    deck.version,
    { slide: slide.number },
    pictures && inView,
  )
  const style = {
    '--adk-sketch-bg': deck.palette.background,
    '--adk-sketch-ink': deck.palette.text,
    '--adk-sketch-accent': deck.palette.accent,
  } as CSSProperties
  return (
    <span ref={box} className="adk-thumb" style={style}>
      {thumbnail.state === 'ready' ? (
        <img src={thumbnail.src} alt="" draggable={false} />
      ) : (
        <span className="adk-sketch" aria-hidden>
          <i />
          {slide.title && <b>{slide.title}</b>}
        </span>
      )}
    </span>
  )
}

/**
 * The left card of a deck: its slides, numbered, with their pictures and titles, the one on screen
 * picked out, narrowed to the changed ones or those with comments. A row goes to its slide.
 */
export function SlidesCard({
  artifactId,
  deck,
  current,
  changed,
  changedIn,
  marks,
  comments,
  onPick,
  writing,
}: {
  artifactId: string
  deck: DeckOutline
  current: number
  /** The slides the version that came in changed, tagged with that version. */
  changed: ReadonlySet<number>
  changedIn: number
  /** The version that last changed each changed slide, by its number, when not `changedIn`. */
  marks?: ReadonlyMap<string, number>
  /** Open threads by slide. */
  comments: ReadonlyMap<number, number>
  onPick: (slide: number) => void
  /** The slides an agent is writing, by number. */
  writing?: readonly number[] | null
}) {
  const { t } = useTranslation('artifacts')
  const filter = useViewerState(artifactId, (s) => s.pagesFilter)
  const list = useRef<HTMLDivElement>(null)
  const commented = [...comments.values()].reduce((sum, n) => sum + n, 0)
  const shown = deck.slides.filter(
    (s) =>
      filter === 'all' ||
      (filter === 'changed' && changed.has(s.number)) ||
      (filter === 'comments' && (comments.get(s.number) ?? 0) > 0),
  )

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-slide="${current}"]`)?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [current, filter])

  return (
    <ViewerSlot slot="left">
      <div className="k-pages">
        <div className="k-pages__filter">
          <SegmentedControl<PagesFilter>
            variant="tray"
            size="sm"
            aria-label={t('pages.filter')}
            value={filter}
            onChange={(next) => setViewerState(artifactId, { pagesFilter: next })}
            options={[
              { value: 'all', label: t('pages.all') },
              { value: 'changed', label: t('pages.changed'), count: changed.size || undefined },
              { value: 'comments', label: t('pages.comments'), count: commented || undefined },
            ]}
          />
        </div>
        <div ref={list} className="adk-srows" role="listbox" aria-label={t('deck.slides')}>
          {shown.length === 0 ? (
            <NoneHere
              text={filter === 'changed' ? t('deck.noChanged') : t('deck.noComments')}
              onShowAll={() => setViewerState(artifactId, { pagesFilter: 'all' })}
            />
          ) : (
            shown.map((slide) => {
              const count = comments.get(slide.number) ?? 0
              const tagged = changed.has(slide.number)
              const on = slide.number === current
              const held = !!writing?.includes(slide.number)
              return (
                <button
                  key={slide.number}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className="adk-srow"
                  data-slide={slide.number}
                  onClick={() => onPick(slide.number)}
                >
                  <span className="adk-srow__n">{slide.number}</span>
                  <span className="adk-srow__th">
                    <SlideThumb artifactId={artifactId} deck={deck} slide={slide} />
                  </span>
                  <span className="adk-srow__text">
                    <span className="adk-srow__name">{slideName(slide)}</span>
                    {(tagged || count > 0 || held) && (
                      <span className="k-pages__marks">
                        {held && (
                          <span className="k-pages__mark" data-writing="">
                            {t('viewer.writing.row')}
                          </span>
                        )}
                        {tagged && (
                          <span className="k-pages__mark" data-changed="">
                            {t('pages.version', {
                              version: marks?.get(`${slide.number}`) ?? changedIn,
                            })}
                          </span>
                        )}
                        {count > 0 && (
                          <span className="k-pages__mark">
                            <HugeiconsIcon icon={Comment01Icon} size={11} strokeWidth={2} />
                            {count}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </ViewerSlot>
  )
}
