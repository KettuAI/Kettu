import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { bytes } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { useAgentsStore } from '@renderer/stores/agents'
import {
  selectDraft,
  useAttachmentsStore,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import { AttachmentTile, type TileView } from '../attachments/attachment-tile'
import type { ImageDialogTarget } from '../attachments/image-dialog'
import { removeAttachment } from './attachments'

const EASE_OUT_QUART = [0.165, 0.84, 0.44, 1] as const

/**
 * The composer's attachments, one row of tiles above the text: a listbox that is one Tab stop,
 * moved through with the arrow keys. See attachments in the interface design.
 */
export function AttachmentTray({
  draft,
  agentId,
  agentName,
  onOpen,
  onLeave,
}: {
  draft: string
  agentId: AgentId | null
  agentName: string
  onOpen: (target: ImageDialogTarget) => void
  /** Focus leaves the row, as when its last tile is removed. */
  onLeave: () => void
}) {
  const { t } = useTranslation('composer')
  const items = useAttachmentsStore(selectDraft(draft))
  const takesImages = useAgentsStore((s) =>
    agentId ? (s.byId[agentId]?.capabilities.prompt?.image ?? null) : null,
  )
  const reduceMotion = useReducedMotion()
  const row = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const seen = useRef(new Map(items.map((item) => [item.key, item.name])))
  const index = Math.min(active, Math.max(0, items.length - 1))
  const shown = items.length > 0

  // Says what was added or removed, for a screen reader.
  useEffect(() => {
    const now = new Map(items.map((item) => [item.key, item.name]))
    const added = [...now].filter(([key]) => !seen.current.has(key)).map(([, name]) => name)
    const removed = [...seen.current].filter(([key]) => !now.has(key)).map(([, name]) => name)
    seen.current = now
    const said = [
      ...added.map((name) => t('attachments.announceAdded', { name })),
      ...removed.map((name) => t('attachments.announceRemoved', { name })),
    ]
    if (said.length > 0) setAnnouncement(said.join(' '))
  }, [items, t])

  // A vertical wheel scrolls the row sideways; React's wheel listener is passive, so it cannot.
  useEffect(() => {
    const el = row.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      el.scrollLeft += event.deltaY
      event.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [shown])

  if (!shown) {
    return (
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    )
  }

  const focusTile = (i: number) => {
    setActive(i)
    requestAnimationFrame(() =>
      row.current?.querySelectorAll<HTMLElement>('[role="option"]')[i]?.focus(),
    )
  }

  const open = (item: DraftAttachment) => {
    const attachment = item.attachment
    if (!attachment || item.status !== 'ready') return
    onOpen({ name: item.name, read: () => host('attachments.read', { id: attachment.id }) })
  }

  const remove = (i: number) => {
    const item = items[i]
    if (!item) return
    removeAttachment(draft, item.key)
    if (items.length === 1) onLeave()
    else focusTile(Math.min(i, items.length - 2))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1
    switch (event.key) {
      case 'ArrowRight':
        focusTile(Math.min(last, index + 1))
        break
      case 'ArrowLeft':
        focusTile(Math.max(0, index - 1))
        break
      case 'Home':
        focusTile(0)
        break
      case 'End':
        focusTile(last)
        break
      case 'Backspace':
      case 'Delete':
        remove(index)
        break
      case 'Enter':
      case ' ':
        open(items[index]!)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const view = (item: DraftAttachment): TileView =>
    draftView(item, takesImages === false, agentName, t)

  return (
    <div
      ref={row}
      role="listbox"
      aria-label={t('attachments.label')}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex w-full gap-1.5 overflow-x-auto px-1.5 pt-1.5 [scrollbar-width:none] scroll-fade-x"
    >
      <AnimatePresence initial={false}>
        {items.map((item, i) => (
          <motion.div
            key={item.key}
            layout={reduceMotion ? false : 'position'}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={
              reduceMotion
                ? { opacity: 0, transition: { duration: 0.12 } }
                : { opacity: 0, scale: 0.9, transition: { duration: 0.12 } }
            }
            transition={{ duration: 0.2, ease: EASE_OUT_QUART }}
            className="shrink-0"
          >
            <AttachmentTile
              view={view(item)}
              role="option"
              aria-selected={i === index}
              aria-label={`${item.name}, ${view(item).tooltip.split('\n').at(-1)}`}
              tabIndex={i === index ? 0 : -1}
              onFocus={() => setActive(i)}
              onClick={() => open(item)}
              onRemove={() => remove(i)}
              removeLabel={t('attachments.remove', { name: item.name })}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}

type T = ReturnType<typeof useTranslation<'composer'>>['t']

function draftView(item: DraftAttachment, noImages: boolean, agentName: string, t: T): TileView {
  const facts = [
    item.name,
    item.size !== null ? bytes(item.size) : null,
    item.pixels ? `${item.pixels.width} × ${item.pixels.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const note =
    item.status === 'failed'
      ? (item.error ?? t('attachments.cannotRead'))
      : item.status === 'adding'
        ? t('attachments.adding')
        : noImages
          ? t('attachments.sentAsLink', { agent: agentName })
          : item.scaled
            ? t('attachments.sentScaled', { size: `${item.scaled.width} × ${item.scaled.height}` })
            : t('attachments.sentAsImage')
  return {
    name: item.name,
    thumb: item.thumb,
    status: item.status,
    detail:
      item.status === 'failed'
        ? t('attachments.cannotRead')
        : item.size !== null
          ? bytes(item.size)
          : null,
    tooltip: `${facts}\n${note}`,
    warn: item.status === 'ready' && noImages,
  }
}
