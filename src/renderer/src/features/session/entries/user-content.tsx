import { useContext, useEffect, useState } from 'react'
import { FileIcon, LinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { readTextThumb } from '@shared/attachments'
import type { Attachment, ContentRef, UserContent } from '@shared/thread'
import { basename, bytes } from '@renderer/lib/format'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { host } from '@renderer/lib/host'
import { openViewer } from '@renderer/stores/viewer'
import { AttachmentTile, type TileView } from '../attachments/attachment-tile'
import { openAttachmentPath } from '../attachments/open-attachment'
import { TextDialog, type TextDialogTarget } from '../attachments/text-dialog'
import { replayThumb } from '../attachments/thumb'
import { Clamp } from '../clamp'
import { CarriedImage } from '../media/carried-image'
import { attachmentKey } from '../media/viewer-items'

/** Taller than this, a message collapses behind a fade and Show more. */
const COLLAPSED_HEIGHT = 300

const IMAGE = 'max-h-40 max-w-60 rounded-lg object-cover shadow-card'

/**
 * The text, images and references of a prompt, as the user wrote them. In the thread, its images
 * open the viewer.
 */
export function UserContentView({
  content,
  sessionId,
  entryId,
}: {
  content: UserContent[]
  sessionId?: string
  entryId?: string
}) {
  const text = content
    .filter((c): c is Extract<UserContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n')
  const refs = content.flatMap((c) => (c.type === 'ref' ? [c.ref] : []))
  return (
    <div className="flex flex-col gap-2">
      {text && (
        <div className="flex flex-col gap-1">
          <Clamp maxHeight={COLLAPSED_HEIGHT} buttonClassName="-mx-1.5 -mb-0.5">
            <div className="whitespace-pre-wrap" data-selectable="">
              {text}
            </div>
          </Clamp>
        </div>
      )}
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {refs.map((ref, i) =>
            ref.kind === 'image' ? (
              sessionId && entryId ? (
                <CarriedImage
                  key={i}
                  sessionId={sessionId}
                  entryId={entryId}
                  index={i}
                  mimeType={ref.mimeType}
                  data={ref.data}
                  className={IMAGE}
                />
              ) : (
                <img
                  key={i}
                  alt=""
                  src={`data:${ref.mimeType};base64,${ref.data}`}
                  className={IMAGE}
                />
              )
            ) : (
              <RefChip key={i} contentRef={ref} />
            ),
          )}
        </div>
      )}
    </div>
  )
}

/** A link, an attachment or content OverBench cannot show, as a labelled chip. */
export function RefChip({ contentRef }: { contentRef: Exclude<ContentRef, { kind: 'image' }> }) {
  const link = contentRef.kind === 'link'
  const label =
    contentRef.kind === 'link'
      ? contentRef.name || basename(contentRef.uri)
      : contentRef.kind === 'attachment'
        ? contentRef.attachment.name
        : contentRef.label
  return (
    <span
      className="inline-flex h-6 max-w-60 items-center gap-1.5 rounded-[6px] bg-background/60 px-2 text-xs text-muted-foreground shadow-card"
      title={link ? contentRef.uri : label}
    >
      {link &&
        (contentRef.uri.startsWith('file:') ? (
          <FileIcon className="size-3 shrink-0" />
        ) : (
          <LinkIcon className="size-3 shrink-0" />
        ))}
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * A sent message's attachments: tiles in a row above its bubble, which open as in the composer;
 * an image in the viewer, with the thread's other pictures.
 */
export function SentAttachments({
  sessionId,
  entryId,
  attachments,
}: {
  /** Null for a first message whose session does not exist yet, which nothing has sent. */
  sessionId: string | null
  entryId: string | null
  attachments: Attachment[]
}) {
  const [viewing, setViewing] = useState<TextDialogTarget | null>(null)
  const projectPath = useContext(ProjectPathContext)
  const viewerKey = (attachment: Attachment) => attachmentKey(entryId ?? '', attachment.id)
  const open = (attachment: Attachment, from: HTMLElement) => {
    if (attachment.type === 'file' || attachment.type === 'folder') {
      openAttachmentPath(attachment, projectPath).catch((error: unknown) =>
        console.warn(`Could not open ${attachment.name}`, error),
      )
      return
    }
    if (attachment.type === 'image') {
      openViewer({
        sessionId,
        projectPath,
        draft: sessionId,
        item: {
          key: viewerKey(attachment),
          source: { kind: 'attachment', attachment },
          name: attachment.name,
          alt: '',
        },
        from,
      })
      return
    }
    const hash = attachment.blob
    setViewing({
      name: attachment.name,
      read: () =>
        hash && sessionId
          ? host('sessions.blob', { sessionId, hash })
          : host('attachments.read', { id: attachment.id }),
    })
  }
  return (
    <div role="list" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {attachments.map((attachment) => (
        <div key={attachment.id} role="listitem">
          <SentAttachment
            sessionId={sessionId}
            attachment={attachment}
            viewerKey={attachment.type === 'image' ? viewerKey(attachment) : undefined}
            onOpen={open}
          />
        </div>
      ))}
      <TextDialog target={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

/**
 * One sent attachment. A replayed image has no thumbnail, so its bytes are read and a thumbnail
 * made the first time its tile shows.
 */
function SentAttachment({
  sessionId,
  attachment,
  viewerKey,
  onOpen,
}: {
  sessionId: string | null
  attachment: Attachment
  viewerKey?: string
  onOpen: (attachment: Attachment, from: HTMLElement) => void
}) {
  const { t } = useTranslation('composer')
  // The made thumbnail belongs to the bytes it was made from, so another attachment or a byte
  // set that arrives later starts over.
  const key = attachment.thumb ?? attachment.blob
  const [made, setMade] = useState<{
    key: string | null
    thumb: string | null
    failed: boolean
  }>({ key: null, thumb: null, failed: false })
  useEffect(() => {
    if (attachment.thumb || attachment.type !== 'image' || !attachment.blob || !sessionId) return
    let cancelled = false
    void replayThumb(sessionId, attachment).then((thumb) => {
      if (!cancelled) setMade({ key, thumb, failed: thumb === null })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, key, attachment])
  const current = made.key === key
  const thumb = attachment.thumb ?? (current ? made.thumb : null)
  const failed = current && made.failed
  const view = sentView(attachment, t, thumb, failed)
  return (
    <AttachmentTile
      view={view}
      role="button"
      tabIndex={0}
      aria-label={`${attachment.name}, ${view.tooltip.split('\n').at(-1)}`}
      data-viewer-key={viewerKey}
      onClick={(event) => onOpen(attachment, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(attachment, event.currentTarget)
      }}
    />
  )
}

type T = ReturnType<typeof useTranslation<'composer'>>['t']

function sentView(
  attachment: Attachment,
  t: T,
  thumb: string | null = attachment.thumb,
  failed = false,
): TileView {
  const size =
    attachment.type === 'folder'
      ? t('attachments.folder')
      : attachment.size !== null
        ? bytes(attachment.size)
        : null
  const preview = attachment.type === 'text' ? readTextThumb(attachment.thumb) : null
  const lines = preview ? t('attachments.lines', { count: preview.count }) : null
  const facts = [attachment.name, lines, size].filter(Boolean).join(' · ')
  const note =
    attachment.sent === 'image'
      ? t('attachments.sentAsImage')
      : attachment.sent === 'embedded'
        ? t('attachments.sentWithContents')
        : attachment.sent === 'inline'
          ? t('attachments.sentInline')
          : attachment.sent === 'linked'
            ? t(
                attachment.type === 'folder'
                  ? 'attachments.sentLinkedFolder'
                  : 'attachments.sentLinked',
              )
            : null
  const pendingThumb = !failed && attachment.type === 'image' && !thumb && attachment.blob !== null
  return {
    name: attachment.name,
    kind: attachment.type,
    thumb,
    status: failed ? 'failed' : pendingThumb ? 'adding' : 'ready',
    detail: failed ? t('attachments.cannotRead') : (lines ?? size),
    tooltip: note ? `${facts}\n${note}` : facts,
    warn: attachment.type === 'image' && attachment.sent === 'linked',
  }
}
