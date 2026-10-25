import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { embedsText, readTextThumb } from '@shared/attachments'
import type { AgentId } from '@shared/thread'
import { bytes } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useAgentsStore } from '@renderer/stores/agents'
import {
  selectDraft,
  useAttachmentsStore,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import { AttachmentTile, type TileView } from '../attachments/attachment-tile'
import type { ImageDialogTarget } from '../attachments/image-dialog'
import { openAttachmentPath } from '../attachments/open-attachment'
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
  projectPath,
  onOpen,
  onPasteAsText,
  onError,
  onLeave,
}: {
  draft: string
  agentId: AgentId | null
  agentName: string
  /** The session's folder, whose files open in the Files pane. */
  projectPath: string | null
  onOpen: (target: ImageDialogTarget) => void
  /** Puts a pasted text back in the box, in place of its tile. */
  onPasteAsText: (key: string, text: string) => void
  onError: (message: string) => void
  /** Focus leaves the row, as when its last tile is removed. */
  onLeave: () => void
}) {
  const { t } = useTranslation('composer')
  const items = useAttachmentsStore(selectDraft(draft))
  const takesImages = useAgentsStore((s) =>
    agentId ? (s.byId[agentId]?.capabilities.prompt?.image ?? null) : null,
  )
  const takesText = useAgentsStore((s) =>
    agentId ? (s.byId[agentId]?.capabilities.prompt?.embeddedContext ?? null) : null,
  )
  const reduceMotion = useReducedMotion()
  const row = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const seen = useRef(new Set(items.map((item) => item.key)))
  const index = Math.min(active, Math.max(0, items.length - 1))
  const shown = items.length > 0

  // Says what was added, for a screen reader. A removal is said where the user removes one, so
  // the tiles of a message being sent are not read out as removed.
  useEffect(() => {
    const added = items.filter((item) => !seen.current.has(item.key))
    seen.current = new Set(items.map((item) => item.key))
    if (added.length === 0) return
    setAnnouncement(
      added.map((item) => t('attachments.announceAdded', { name: item.name })).join(' '),
    )
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

  // By key: a removed tile stays in the row while it fades out, so an index could land on it.
  const focusTile = (key: string, i: number) => {
    setActive(i)
    requestAnimationFrame(() =>
      row.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(),
    )
  }
  const focusAt = (i: number) => focusTile(items[i]!.key, i)

  const open = (item: DraftAttachment) => {
    const attachment = item.attachment
    if (!attachment || item.status !== 'ready') return
    const read = () => host('attachments.read', { id: attachment.id })
    if (attachment.type === 'image') {
      onOpen({ name: item.name, read })
    } else if (attachment.type === 'text') {
      onOpen({
        name: item.name,
        read,
        text: true,
        pasteAsText: (text) => {
          onPasteAsText(item.key, text)
          setAnnouncement(t('attachments.announceRemoved', { name: item.name }))
        },
      })
    } else {
      openAttachmentPath(attachment, projectPath).catch((e: unknown) => onError(errorMessage(e)))
    }
  }

  const remove = (i: number) => {
    const item = items[i]
    if (!item) return
    removeAttachment(draft, item.key)
    setAnnouncement(t('attachments.announceRemoved', { name: item.name }))
    // The next tile takes focus, or the text after the last one.
    if (i === items.length - 1) onLeave()
    else focusTile(items[i + 1]!.key, i)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1
    switch (event.key) {
      case 'ArrowRight':
        focusAt(Math.min(last, index + 1))
        break
      case 'ArrowLeft':
        focusAt(Math.max(0, index - 1))
        break
      case 'Home':
        focusAt(0)
        break
      case 'End':
        focusAt(last)
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
    draftView(item, { images: takesImages !== false, text: takesText !== false }, agentName, t)

  // The live region stays one node, outside the listbox, whether or not the row shows.
  return (
    <>
      {shown && (
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
                  data-key={item.key}
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
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  )
}

type T = ReturnType<typeof useTranslation<'composer'>>['t']

function draftView(
  item: DraftAttachment,
  takes: { images: boolean; text: boolean },
  agentName: string,
  t: T,
): TileView {
  const size =
    item.kind === 'folder' ? t('attachments.folder') : item.size !== null ? bytes(item.size) : null
  const preview = item.kind === 'text' ? readTextThumb(item.thumb) : null
  const lines = preview ? t('attachments.lines', { count: preview.count }) : null
  const facts = [
    item.name,
    lines,
    size,
    item.pixels ? `${item.pixels.width} × ${item.pixels.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const noImages = item.kind === 'image' && !takes.images
  const note =
    item.status === 'failed'
      ? (item.error ?? t('attachments.cannotRead'))
      : item.status === 'adding'
        ? t('attachments.adding')
        : item.kind === 'text'
          ? takes.text
            ? t('attachments.sentWithContents')
            : t('attachments.sentInline')
          : item.kind !== 'image'
            ? item.attachment && embedsText(item.attachment) && takes.text
              ? t('attachments.sentWithContents')
              : t('attachments.sentAsFileLink', { agent: agentName })
            : noImages
              ? t('attachments.sentAsLink', { agent: agentName })
              : item.scaled
                ? t('attachments.sentScaled', {
                    size: `${item.scaled.width} × ${item.scaled.height}`,
                  })
                : t('attachments.sentAsImage')
  return {
    name: item.name,
    kind: item.kind,
    thumb: item.thumb,
    status: item.status,
    detail:
      item.status === 'failed'
        ? t(item.gone ? 'attachments.unavailable' : 'attachments.cannotRead')
        : (lines ?? size),
    tooltip: `${facts}\n${note}`,
    warn: item.status === 'ready' && noImages,
  }
}
