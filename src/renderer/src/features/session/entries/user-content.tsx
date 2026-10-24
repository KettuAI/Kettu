import { useContext, useState } from 'react'
import { FileIcon, LinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Attachment, ContentRef, UserContent } from '@shared/thread'
import { basename, bytes } from '@renderer/lib/format'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { host } from '@renderer/lib/host'
import { AttachmentTile, type TileView } from '../attachments/attachment-tile'
import { ImageDialog, type ImageDialogTarget } from '../attachments/image-dialog'
import { openAttachmentPath } from '../attachments/open-attachment'
import { Clamp } from '../clamp'

/** Taller than this, a message collapses behind a fade and Show more. */
const COLLAPSED_HEIGHT = 300

/** The text, images and references of a prompt, as the user wrote them. */
export function UserContentView({ content }: { content: UserContent[] }) {
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
              <img
                key={i}
                alt=""
                src={`data:${ref.mimeType};base64,${ref.data}`}
                className="max-h-40 max-w-60 rounded-lg object-cover shadow-card"
              />
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

/** A sent message's attachments: tiles in a row above its bubble, which open as in the composer. */
export function SentAttachments({
  sessionId,
  attachments,
}: {
  /** Null for a first message whose session does not exist yet, which nothing has sent. */
  sessionId: string | null
  attachments: Attachment[]
}) {
  const { t } = useTranslation('composer')
  const [viewing, setViewing] = useState<ImageDialogTarget | null>(null)
  const projectPath = useContext(ProjectPathContext)
  const open = (attachment: Attachment) => {
    if (attachment.type === 'file' || attachment.type === 'folder') {
      openAttachmentPath(attachment, projectPath).catch((error: unknown) =>
        console.warn(`Could not open ${attachment.name}`, error),
      )
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
      {attachments.map((attachment) => {
        const view = sentView(attachment, t)
        return (
          <div key={attachment.id} role="listitem">
            <AttachmentTile
              view={view}
              role="button"
              tabIndex={0}
              aria-label={`${attachment.name}, ${view.tooltip.split('\n').at(-1)}`}
              onClick={() => open(attachment)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                open(attachment)
              }}
            />
          </div>
        )
      })}
      <ImageDialog target={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

type T = ReturnType<typeof useTranslation<'composer'>>['t']

function sentView(attachment: Attachment, t: T): TileView {
  const size =
    attachment.type === 'folder'
      ? t('attachments.folder')
      : attachment.size !== null
        ? bytes(attachment.size)
        : null
  const facts = [attachment.name, size].filter(Boolean).join(' · ')
  const note =
    attachment.sent === 'image'
      ? t('attachments.sentAsImage')
      : attachment.sent === 'embedded'
        ? t('attachments.sentWithContents')
        : attachment.sent === 'linked'
          ? t(
              attachment.type === 'folder'
                ? 'attachments.sentLinkedFolder'
                : 'attachments.sentLinked',
            )
          : null
  return {
    name: attachment.name,
    kind: attachment.type,
    thumb: attachment.thumb,
    status: 'ready',
    detail: size,
    tooltip: note ? `${facts}\n${note}` : facts,
    warn: attachment.type === 'image' && attachment.sent === 'linked',
  }
}
