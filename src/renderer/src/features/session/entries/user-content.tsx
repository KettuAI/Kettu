import { Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FileIcon, LinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { readTextThumb } from '@shared/attachments'
import type { Attachment, ContentRef, ThreadEntry, UserContent } from '@shared/thread'
import { basename, bytes } from '@renderer/lib/format'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { ensureFiles, openFile, useFilesStore } from '@renderer/stores/files'
import { useThreadsStore } from '@renderer/stores/threads'
import { openViewer } from '@renderer/stores/viewer'
import { AttachmentTile, type TileView } from '../attachments/attachment-tile'
import { openAttachmentPath } from '../attachments/open-attachment'
import { TextDialog, type TextDialogTarget } from '../attachments/text-dialog'
import { replayThumb } from '../attachments/thumb'
import { Clamp } from '../clamp'
import { ChipView } from '../composer/chip-view'
import { findChips, mentioned, mentionResolver, type Chip } from '../composer/chips'
import { useLinkOpener } from '../composer/link-opener'
import { projectOf } from '../composer/prompt-chips'
import { CarriedImage } from '../media/carried-image'
import { CarriedMedia } from '../media/carried-media'
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
  const text = textOf(content)
  const refs = content.flatMap((c) => (c.type === 'ref' ? [c.ref] : []))
  return (
    <div className="flex flex-col gap-2">
      {text && (
        <div className="flex flex-col gap-1">
          <Clamp maxHeight={COLLAPSED_HEIGHT} buttonClassName="-mx-1.5 -mb-0.5">
            <ChipText text={text} sessionId={sessionId} entryId={entryId} />
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
            ) : ref.kind === 'audio' || ref.kind === 'video' ? (
              <CarriedMedia
                key={i}
                sessionId={sessionId ?? null}
                entryId={entryId ?? null}
                index={i}
                carried={ref}
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

function textOf(content: readonly UserContent[]): string {
  return content
    .filter((c): c is Extract<UserContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n')
}

/** The attachments a sent prompt carried. */
function attachmentsOf(entry: ThreadEntry | undefined): Attachment[] {
  if (entry?.kind !== 'user') return []
  return entry.content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment] : [],
  )
}

function useSentEntry(sessionId: string | null | undefined, entryId: string | null | undefined) {
  return useThreadsStore((s) =>
    sessionId && entryId ? s.replicas[sessionId]?.state?.byId[entryId] : undefined,
  )
}

/** Resolves a sent prompt's mentions against what it carried, then the project's files. */
function useSentResolver(attachments: readonly Attachment[], text: string) {
  const projectPath = useContext(ProjectPathContext)
  const files = useFilesStore((s) => (projectPath ? s.byProject[projectPath] : undefined))
  const mentions = /[@＠]/.test(text)
  useEffect(() => {
    if (projectPath && mentions) ensureFiles(projectPath)
  }, [projectPath, mentions])
  return useMemo(
    () =>
      mentionResolver(
        attachments.map((a) => ({ key: a.id, name: a.name, kind: a.type, thumb: a.thumb })),
        files ? projectOf(files.paths, files.known) : null,
      ),
    [attachments, files],
  )
}

/** Opens a sent attachment as its tile does: an image in the viewer, a file or folder itself. */
function openSent(
  attachment: Attachment,
  from: HTMLElement,
  where: { sessionId: string | null; entryId: string | null; projectPath: string | null },
) {
  if (attachment.type === 'image') {
    openViewer({
      sessionId: where.sessionId,
      projectPath: where.projectPath,
      draft: where.sessionId,
      item: {
        key: attachmentKey(where.entryId ?? '', attachment.id),
        source: { kind: 'attachment', attachment },
        name: attachment.name,
        alt: '',
      },
      from,
    })
    return
  }
  openAttachmentPath(attachment, where.projectPath).catch((error: unknown) =>
    console.warn(`Could not open ${attachment.name}`, error),
  )
}

/**
 * A prompt's text with its command, mentions and links as the composer showed them: chips that
 * open what they name. A local address opens in the session's browser.
 */
function ChipText({
  text,
  sessionId,
  entryId,
}: {
  text: string
  sessionId?: string
  entryId?: string
}) {
  const projectPath = useContext(ProjectPathContext)
  const entry = useSentEntry(sessionId, entryId)
  const attachments = useMemo(() => attachmentsOf(entry), [entry])
  const resolve = useSentResolver(attachments, text)
  const commands = useThreadsStore((s) =>
    sessionId ? s.replicas[sessionId]?.state?.session.commands : undefined,
  )
  const chips = useMemo(
    () => findChips(text, { commands: commands?.map((c) => c.name) ?? [], resolve }),
    [text, commands, resolve],
  )
  const links = useLinkOpener(sessionId)
  const opener = (chip: Chip): ((from: HTMLElement) => void) | null => {
    if (chip.kind === 'command') return null
    if (chip.kind === 'link') return () => links.open(chip.url)
    const attachment = attachments.find((a) => a.id === chip.attachmentKey)
    if (attachment) {
      return (from) =>
        openSent(attachment, from, {
          sessionId: sessionId ?? null,
          entryId: entryId ?? null,
          projectPath,
        })
    }
    if (chip.kind !== 'file' || !chip.path || !projectPath) return null
    const path = chip.path
    const line = chip.lines ? Number(chip.lines.split('–')[0]) : null
    return () => openFile(projectPath, path, line)
  }

  const parts: ReactNode[] = []
  let at = 0
  for (const chip of chips) {
    if (chip.from > at) parts.push(text.slice(at, chip.from))
    const open = opener(chip)
    // A selection copies what was typed: the chip's look is left out of it, its text is not.
    const raw = text.slice(chip.from, chip.to)
    parts.push(
      <Fragment key={chip.from}>
        {open ? (
          <button
            type="button"
            aria-label={raw}
            title={chip.kind === 'link' ? chip.url : undefined}
            onClick={(event) => open(event.currentTarget)}
            className="rounded-lg align-middle outline-none select-none focus-visible:focus-ring"
          >
            <ChipView chip={chip} surface />
          </button>
        ) : (
          <span aria-hidden className="select-none">
            <ChipView chip={chip} surface />
          </span>
        )}
        <span aria-hidden={open ? true : undefined} className="sr-only">
          {raw}
        </span>
      </Fragment>,
    )
    at = chip.to
  }
  if (at < text.length) parts.push(text.slice(at))
  return (
    <div
      className={cn('whitespace-pre-wrap', chips.length > 0 && 'leading-7.5')}
      data-selectable=""
    >
      {parts}
      {links.dialog}
    </div>
  )
}

/** A link, an attachment or content Kettu cannot show, as a labelled chip. */
export function RefChip({
  contentRef,
}: {
  contentRef: Exclude<ContentRef, { kind: 'image' | 'audio' | 'video' }>
}) {
  const link = contentRef.kind === 'link'
  const label =
    contentRef.kind === 'link'
      ? contentRef.name || basename(contentRef.uri)
      : contentRef.kind === 'attachment'
        ? contentRef.attachment.name
        : contentRef.label
  return (
    <span
      className="inline-flex h-6 max-w-60 items-center gap-1.5 rounded-md bg-background/60 px-2 text-xs text-muted-foreground shadow-card"
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
  // A file or folder the text names is its chip there; images stay above as thumbnails.
  const entry = useSentEntry(sessionId, entryId)
  const text = entry?.kind === 'user' ? textOf(entry.content) : ''
  const resolve = useSentResolver(attachments, text)
  const named = useMemo(() => mentioned(text, resolve), [text, resolve])
  const shown = attachments.filter((a) => a.type === 'image' || !named.has(a.id))
  const open = (attachment: Attachment, from: HTMLElement) => {
    if (attachment.type !== 'text') {
      openSent(attachment, from, { sessionId, entryId, projectPath })
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
  if (shown.length === 0) return null
  return (
    <div role="list" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {shown.map((attachment) => (
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
      picture="large"
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
