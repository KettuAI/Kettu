import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  Comment01Icon,
  File01Icon,
  Layers01Icon,
  Search01Icon,
  SmartPhone01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { CanvasDoc, CanvasPage } from '@shared/canvas-doc'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { TreeView, type TreeNode } from '@renderer/components/affect/tree-view'
import { HoverCard, HoverCardContent } from '@renderer/components/ui/hover-card'
import { useHostHas } from '@renderer/lib/host-features'
import { setViewerState, useViewerState, type PagesFilter } from '@renderer/stores/artifact-viewer'
import { FrameThumb } from './canvas-present'
import { ViewerSlot } from './viewer-shell'
import { NoneHere } from './viewer-states'

/** Frames up to this wide are drawn as phones; taller than wide by this much, as documents. */
const PHONE_WIDTH = 520
const DOC_RATIO = 1.2
/** How long the pointer rests on a frame's row before its picture shows. */
const HOVER_MS = 400

function frameIcon(frame: CanvasPage): IconSvgElement {
  if (frame.width <= PHONE_WIDTH) return SmartPhone01Icon
  return frame.height / frame.width > DOC_RATIO ? File01Icon : Layers01Icon
}

/**
 * The left card of a canvas: its pages and their frames as one tree, found by name and narrowed
 * to the changed ones or those with comments. A page's row shows it, a frame's selects it and a
 * double click or Enter opens it.
 */
export function PagesCard({
  doc,
  canvasKey,
  selection,
  opened,
  changed,
  comments,
  artifactId,
  version,
  marks,
  faults,
  writing,
  onPage,
  onFrame,
  onOpen,
}: {
  doc: CanvasDoc
  canvasKey: string
  selection: readonly string[]
  opened: string | null
  changed: ReadonlySet<string>
  comments: ReadonlyMap<string, number>
  artifactId: string
  version: number
  /** The version that last changed each changed frame, when not `version`. */
  marks?: ReadonlyMap<string, number>
  /** The frames that cannot show, which say so on their rows. */
  faults?: ReadonlySet<string>
  /** The frames an agent writes now, with its mark. */
  writing?: ReadonlyMap<string, ReactNode>
  onPage: (id: string) => void
  onFrame: (id: string) => void
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation('artifacts')
  const filter = useViewerState(artifactId, (s) => s.pagesFilter)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [expanded, setExpanded] = useState<string[]>(() => [canvasKey])
  const thumbnails = useHostHas('partThumbnails') === true

  // The shown page opens in the tree when it changes.
  const [lastKey, setLastKey] = useState(canvasKey)
  if (lastKey !== canvasKey) {
    setLastKey(canvasKey)
    if (!expanded.includes(canvasKey)) setExpanded([...expanded, canvasKey])
  }

  const changedCount = doc.pages.filter((p) => changed.has(p.id)).length
  const commentedCount = doc.pages.filter((p) => (comments.get(p.id) ?? 0) > 0).length
  const needle = query.trim().toLocaleLowerCase()
  const narrowed = needle !== '' || filter !== 'all'

  const items = useMemo<TreeNode[]>(() => {
    const keep = (p: CanvasPage) =>
      (filter === 'all' ||
        (filter === 'changed' && changed.has(p.id)) ||
        (filter === 'comments' && (comments.get(p.id) ?? 0) > 0)) &&
      (needle === '' || p.name.toLocaleLowerCase().includes(needle))
    return doc.canvases.flatMap((canvas, i) => {
      const frames = doc.pages.filter((p) => p.canvas === canvas.id)
      const shown = frames.filter(keep)
      if (narrowed && shown.length === 0) return []
      return [
        {
          id: canvas.id,
          label: `${i + 1}  ${canvas.name}`,
          meta: <span className="k-pages__meta">{frames.length}</span>,
          children: shown.map((p) => {
            const count = comments.get(p.id) ?? 0
            const fault = faults?.has(p.id) ?? false
            const writer = writing?.get(p.id)
            return {
              id: p.id,
              label: p.name,
              icon: <HugeiconsIcon icon={frameIcon(p)} size={14} strokeWidth={1.9} />,
              meta:
                changed.has(p.id) || count > 0 || fault || writer ? (
                  <span className="k-pages__marks">
                    {writer && (
                      <span className="k-pages__writer" title={t('viewer.writing.row')}>
                        {writer}
                      </span>
                    )}
                    {fault && (
                      <span className="k-vs-row-warn" title={t('viewer.frameFailed')}>
                        <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={2} />
                      </span>
                    )}
                    {changed.has(p.id) && (
                      <span className="k-pages__mark" data-changed="">
                        {t('pages.version', { version: marks?.get(p.id) ?? version })}
                      </span>
                    )}
                    {count > 0 && (
                      <span className="k-pages__mark">
                        <HugeiconsIcon icon={Comment01Icon} size={11} strokeWidth={2} />
                        {count}
                      </span>
                    )}
                  </span>
                ) : undefined,
            }
          }),
        },
      ]
    })
  }, [doc, filter, needle, narrowed, changed, comments, version, marks, faults, writing, t])

  // Narrowing opens every page that still holds a frame.
  const shownExpanded = narrowed ? items.map((n) => n.id) : expanded
  const frameIds = useMemo(() => new Set(doc.pages.map((p) => p.id)), [doc])
  const selected = opened ?? selection[0] ?? canvasKey

  // A frame's picture beside its row while the pointer rests on it.
  const [hover, setHover] = useState<{ id: string; el: HTMLElement } | null>(null)
  const hoverTimer = useRef(0)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const hovered = hover ? doc.pages.find((p) => p.id === hover.id) : undefined

  const rowOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"][data-id]') : null

  return (
    <>
      <ViewerSlot slot="leftHead">
        <button
          type="button"
          className="avs-card__close"
          aria-label={t('pages.search')}
          title={t('pages.search')}
          aria-pressed={searching}
          onClick={() => {
            setSearching((on) => !on)
            setQuery('')
          }}
        >
          <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.9} />
        </button>
      </ViewerSlot>
      <div className="k-pages">
        {searching && (
          <input
            autoFocus
            type="search"
            value={query}
            placeholder={t('pages.find')}
            aria-label={t('pages.search')}
            className="k-pages__find"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setSearching(false)
                setQuery('')
              }
            }}
          />
        )}
        <div className="k-pages__filter">
          <SegmentedControl<PagesFilter>
            variant="tray"
            size="sm"
            aria-label={t('pages.filter')}
            value={filter}
            onChange={(next) => setViewerState(artifactId, { pagesFilter: next })}
            options={[
              { value: 'all', label: t('pages.all') },
              { value: 'changed', label: t('pages.changed'), count: changedCount || undefined },
              { value: 'comments', label: t('pages.comments'), count: commentedCount || undefined },
            ]}
          />
        </div>
        <div
          className="k-pages__tree"
          onDoubleClick={(event) => {
            const id = rowOf(event.target)?.dataset.id
            if (id && frameIds.has(id)) onOpen(id)
          }}
          onKeyDown={(event) => {
            const id = rowOf(event.target)?.dataset.id
            if (event.key === 'Enter' && id && frameIds.has(id)) {
              event.preventDefault()
              event.stopPropagation()
              onOpen(id)
            }
          }}
          onPointerOver={(event) => {
            const row = rowOf(event.target)
            const id = row?.dataset.id
            if (hover?.id === id) return
            clearTimeout(hoverTimer.current)
            setHover(null)
            if (!row || !id || !frameIds.has(id) || !thumbnails) return
            hoverTimer.current = window.setTimeout(() => setHover({ id, el: row }), HOVER_MS)
          }}
          onPointerLeave={() => {
            clearTimeout(hoverTimer.current)
            setHover(null)
          }}
        >
          {narrowed && items.length === 0 ? (
            <NoneHere
              text={
                needle
                  ? t('pages.noMatch', { query: query.trim() })
                  : filter === 'changed'
                    ? t('pages.noChanged')
                    : t('pages.noComments')
              }
              onShowAll={() => {
                setQuery('')
                setViewerState(artifactId, { pagesFilter: 'all' })
              }}
            />
          ) : (
            <TreeView
              items={items}
              expanded={shownExpanded}
              onExpandedChange={narrowed ? undefined : setExpanded}
              selected={selected}
              onSelect={(id) => (frameIds.has(id) ? onFrame(id) : onPage(id))}
              guides={false}
              emptyText={t('pages.none')}
              aria-label={t('pages.title')}
            />
          )}
        </div>
      </div>
      {hover && hovered && (
        <HoverCard open>
          <HoverCardContent anchor={hover.el} side="right" align="start" className="k-pages__peek">
            <span
              className="k-pages__peekpic"
              style={{
                aspectRatio: `${hovered.width} / ${Math.min(hovered.height, hovered.width * 1.6)}`,
              }}
            >
              <FrameThumb artifactId={artifactId} version={version} frame={hovered.id} />
            </span>
            <span className="k-pages__peekname">
              {hovered.name}
              <span>{`${hovered.width} × ${hovered.height}`}</span>
            </span>
          </HoverCardContent>
        </HoverCard>
      )}
    </>
  )
}
