import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { File01Icon, Link01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { readTextThumb } from '@shared/attachments'
import { githubReferenceFromLink } from '@shared/git'
import type { PluginMentionRef } from '@shared/plugin-refs'
import {
  isSkillCommand,
  type Attachment,
  type ContentRef,
  type ThreadEntry,
  type UserContent,
} from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { basename, bytes, fileUrlPath } from '@renderer/lib/format'
import type { FilePreviewSource } from '@renderer/features/files/file-hover-cache'
import { parseLineRangeText, shouldReadAsText } from '@renderer/features/files/file-hover-model'
import { FileHoverPreview } from '@renderer/features/files/file-hover-preview'
import { relativeToRoot } from '@renderer/features/files/file-location'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { ReferenceHoverCard } from '@renderer/features/git/gh-reference'
import { useProjectRepository } from '@renderer/features/git/gh-reference-data'
import { host } from '@renderer/lib/host'
import { hostPlatform, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { ensureFiles, openFile, useFilesStore } from '@renderer/stores/files'
import { useBrowserStore } from '@renderer/stores/browser'
import { useDevicesStore } from '@renderer/stores/devices'
import {
  ensureSessionBrowserTabs,
  useSessionBrowserTabsStore,
} from '@renderer/stores/session-browser-tabs'
import { useTerminalsStore } from '@renderer/stores/terminals'
import { revealSurface } from '@renderer/features/shell/open-surfaces'
import { useThreadsStore } from '@renderer/stores/threads'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { openViewer } from '@renderer/stores/viewer'
import { AttachmentTile, type TileView } from '../attachments/attachment-tile'
import { openAttachmentPath } from '../attachments/open-attachment'
import { TextDialog, type TextDialogTarget } from '../attachments/text-dialog'
import { replayThumb } from '../attachments/thumb'
import { Clamp } from '../clamp'
import { splitAttachedArtifactsPrompt } from '../composer/artifact-attachments'
import { SentBrowserAnnotationChips } from '../composer/browser-annotation-chips'
import { splitBrowserAnnotationsPrompt } from '../composer/browser-annotations'
import { ChipView } from '../composer/chip-view'
import {
  isSurfaceMention,
  mentioned,
  mentionResolver,
  NO_SURFACES,
  type Chip,
  type MentionItem,
  type MentionSurfaces,
} from '../composer/chips'
import { useLinkOpener } from '../composer/link-opener'
import { projectOf } from '../composer/prompt-chips'
import { ArtifactLink } from '../markdown/artifact-link'
import { CarriedImage } from '../media/carried-image'
import { CarriedMedia } from '../media/carried-media'
import { SessionIdContext } from '../media/grants'
import { attachmentKey } from '../media/viewer-items'
import { SentText } from './sent-text'

const SentMarkdown = lazy(() => import('./sent-markdown'))

/** Taller than this, a message collapses behind a fade and Show more. */
const COLLAPSED_HEIGHT = 300

const IMAGE = 'max-h-40 max-w-60 rounded-lg object-cover shadow-card'

/**
 * The text, images and references of a prompt, as the user wrote them. In the thread, its images
 * open the viewer.
 *
 * User-typed messages render verbatim with Kettu chips and explicit fenced code blocks; set
 * `markdown` only for agent-to-agent or Kettu-authored cards that intentionally carry Markdown.
 */
export function UserContentView({
  content,
  sessionId,
  entryId,
  markdown = false,
}: {
  content: UserContent[]
  sessionId?: string
  entryId?: string
  markdown?: boolean
}) {
  const { t } = useTranslation('composer')
  const rawText = textOf(content)
  const parsedArtifacts = splitAttachedArtifactsPrompt(rawText)
  const afterArtifacts = parsedArtifacts ? parsedArtifacts.text : rawText
  const parsedBrowser = splitBrowserAnnotationsPrompt(afterArtifacts)
  const text = parsedBrowser ? parsedBrowser.text : afterArtifacts
  const attachedArtifacts = parsedArtifacts?.artifacts ?? []
  const browserAnnotations = parsedBrowser?.annotations ?? []
  const hasAttachedArtifacts = attachedArtifacts.length > 0
  const hiddenArtifacts = useArtifactsStore((s) => s.hidden)
  useEffect(() => {
    if (!hasAttachedArtifacts) return
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [hasAttachedArtifacts])
  const visibleArtifacts = hasAttachedArtifacts
    ? attachedArtifacts.filter((artifact) => !hiddenArtifacts.has(artifact.id))
    : attachedArtifacts
  // A command of Kettu's is no name the session's agent lists, but its text starts with it.
  const ran = content.some((c) => c.type === 'text' && c.command)
  const command = ran ? (/^\/(\S+)/.exec(text)?.[1] ?? null) : null
  // A terminal, tab or device shows as the chip its mention in the text is.
  const refs = content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind !== 'plugin' && !isSurfaceMention(MENTIONED[c.ref.kind] ?? '')
      ? [c.ref]
      : [],
  )
  return (
    <div className="flex flex-col gap-2">
      {text && (
        <div className="flex flex-col gap-1">
          <Clamp maxHeight={COLLAPSED_HEIGHT} buttonClassName="-mx-1.5 -mb-0.5">
            <ChipText
              text={text}
              command={command}
              sessionId={sessionId}
              entryId={entryId}
              markdown={markdown}
            />
          </Clamp>
        </div>
      )}
      {visibleArtifacts.length > 0 && (
        <SessionIdContext value={sessionId ?? null}>
          <div
            role="list"
            aria-label={t('artifacts.sentLabel')}
            className="flex flex-wrap items-center gap-1.5"
          >
            {visibleArtifacts.map((artifact) => (
              <span
                key={artifact.id}
                role="listitem"
                className="inline-flex max-w-64 items-center overflow-hidden rounded-md bg-background/60 px-2 py-0.5 text-xs text-secondary shadow-card [&_[data-artifact-ref]]:max-w-full [&_[data-artifact-ref]]:truncate"
              >
                <ArtifactLink location={{ artifactId: artifact.id, place: null }}>
                  {artifact.title}
                </ArtifactLink>
              </span>
            ))}
          </div>
        </SessionIdContext>
      )}
      {browserAnnotations.length > 0 && (
        <SentBrowserAnnotationChips annotations={browserAnnotations} />
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
                  image={ref}
                  className={IMAGE}
                />
              ) : 'data' in ref ? (
                <img
                  key={i}
                  alt=""
                  src={`data:${ref.mimeType};base64,${ref.data}`}
                  className={IMAGE}
                />
              ) : null
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

// The mention each kind of reference is written as in the text.
const MENTIONED: Partial<Record<ContentRef['kind'], string>> = {
  terminal: 'terminal',
  page: 'page',
  device: 'device',
}

/** The terminals, browser tabs and devices a sent prompt referenced, as mentions name them. */
function surfacesOf(entry: ThreadEntry | undefined): MentionSurfaces {
  if (entry?.kind !== 'user') return NO_SURFACES
  const terminal: MentionItem[] = []
  const page: MentionItem[] = []
  const device: MentionItem[] = []
  for (const c of entry.content) {
    if (c.type !== 'ref') continue
    const { ref } = c
    if (ref.kind === 'terminal') terminal.push({ id: ref.terminalId, name: ref.name })
    if (ref.kind === 'page') page.push({ id: ref.tabId, name: ref.name })
    if (ref.kind === 'device') device.push({ id: ref.deviceId, name: ref.name })
  }
  return { terminal, page, device }
}

/** The items of plugins a sent prompt mentioned, which its words after `@` name. */
function pluginsOf(entry: ThreadEntry | undefined): PluginMentionRef[] {
  if (entry?.kind !== 'user') return []
  return entry.content.flatMap((c) => (c.type === 'ref' && c.ref.kind === 'plugin' ? [c.ref] : []))
}

/**
 * Resolves a sent prompt's mentions against what it carried, then the project's files. A terminal,
 * tab or device that has gone since reads as missing.
 */
function useSentResolver(
  attachments: readonly Attachment[],
  surfaces: MentionSurfaces,
  plugins: readonly PluginMentionRef[],
  text: string,
  sessionId?: string,
) {
  const projectPath = useContext(ProjectPathContext)
  const files = useFilesStore((s) => (projectPath ? s.byProject[projectPath] : undefined))
  const terminals = useTerminalsStore((s) =>
    surfaces.terminal
      .filter((t) => s.byId[t.id])
      .map((t) => t.id)
      .join('\n'),
  )
  const localPages = useBrowserStore((s) =>
    surfaces.page
      .filter((p) => Object.values(s.bySession).some((b) => b.tabs.some((tab) => tab.id === p.id)))
      .map((p) => p.id)
      .join('\n'),
  )
  const reportedPages = useSessionBrowserTabsStore((s) =>
    surfaces.page
      .filter((p) =>
        sessionId
          ? (s.bySession[sessionId] ?? []).some((tab) => tab.id === p.id)
          : Object.values(s.bySession).some((tabs) => tabs.some((tab) => tab.id === p.id)),
      )
      .map((p) => p.id)
      .join('\n'),
  )
  const devices = useDevicesStore((s) =>
    surfaces.device
      .filter((d) => s.devices.some((device) => device.id === d.id))
      .map((d) => d.id)
      .join('\n'),
  )
  const mentions = /[@＠]/.test(text)
  const hasPageRefs = surfaces.page.length > 0
  useEffect(() => {
    if (projectPath && mentions) ensureFiles(projectPath)
  }, [projectPath, mentions])
  useEffect(() => {
    if (sessionId && hasPageRefs) ensureSessionBrowserTabs(sessionId)
  }, [sessionId, hasPageRefs])
  return useMemo(() => {
    const resolve = mentionResolver(
      attachments.map((a) => ({ key: a.id, name: a.name, kind: a.type, thumb: a.thumb })),
      files ? projectOf(files.paths, files.known) : null,
      surfaces,
      plugins,
    )
    const live = new Set(
      [terminals, localPages, reportedPages, devices].flatMap((ids) => ids.split('\n')),
    )
    return (token: string) => {
      const target = resolve(token)
      return target && isSurfaceMention(target.kind) && !live.has(target.surfaceId ?? '')
        ? { ...target, missing: true }
        : target
    }
  }, [attachments, surfaces, plugins, files, terminals, localPages, reportedPages, devices])
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
  command,
  sessionId,
  entryId,
  markdown,
}: {
  text: string
  /** The name of a command of Kettu's the text starts with. */
  command: string | null
  sessionId?: string
  entryId?: string
  markdown: boolean
}) {
  const projectPath = useContext(ProjectPathContext)
  const repo = useProjectRepository()
  const repoOwner = repo?.owner ?? null
  const repoName = repo?.repo ?? null
  const githubRepo = useMemo(
    () => (repoOwner && repoName ? { owner: repoOwner, repo: repoName } : null),
    [repoOwner, repoName],
  )
  const entry = useSentEntry(sessionId, entryId)
  const attachments = useMemo(() => attachmentsOf(entry), [entry])
  const surfaces = useMemo(() => surfacesOf(entry), [entry])
  const plugins = useMemo(() => pluginsOf(entry), [entry])
  const resolve = useSentResolver(attachments, surfaces, plugins, text, sessionId)
  const commands = useThreadsStore((s) =>
    sessionId ? s.replicas[sessionId]?.state?.session.commands : undefined,
  )
  const context = useMemo(
    () => ({
      commands: [
        ...(commands?.filter((c) => !isSkillCommand(c)).map((c) => c.name) ?? []),
        ...(command === null ? [] : [command]),
      ],
      skills: commands?.filter(isSkillCommand).map((c) => c.name) ?? [],
      resolve,
      githubRepo,
    }),
    [commands, command, resolve, githubRepo],
  )
  const links = useLinkOpener(sessionId)
  const opener = (chip: Chip): ((from: HTMLElement) => void) | null => {
    if (chip.kind === 'command') return null
    if (chip.kind === 'skill') {
      return sessionId
        ? () =>
            emitAppEvent({ kind: 'command-into-composer', sessionId, name: chip.name, skill: true })
        : null
    }
    if (chip.kind === 'link') return () => links.open(chip.url)
    if (isSurfaceMention(chip.kind)) {
      const id = chip.surfaceId
      const kind = chip.kind
      if (!id || !sessionId || chip.missing) return null
      if (kind === 'page') {
        const hasLocal =
          !isWeb &&
          !!useBrowserStore.getState().bySession[sessionId]?.tabs.some((tab) => tab.id === id)
        return hasLocal ? () => revealSurface(sessionId, kind, id) : null
      }
      return () => revealSurface(sessionId, kind, id)
    }
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
    return () => openFile(projectPath, path, line, { preview: true })
  }

  const renderChip = (chip: Chip, raw: string) => {
    // A filled chip inside the bubble reads as a box in a box, so the command is colored text.
    // Clicked, it goes into the composer to be sent again.
    if (chip.kind === 'command') {
      const label = (
        <>
          <span className="text-control-on/55">/</span>
          {chip.name}
        </>
      )
      const look = 'font-medium text-control-on'
      if (!sessionId) return <span className={look}>{label}</span>
      return (
        <>
          <button
            type="button"
            aria-label={raw}
            onClick={() =>
              emitAppEvent({ kind: 'command-into-composer', sessionId, name: chip.name })
            }
            className={cn(
              look,
              'rounded-sm outline-none select-none hover:underline focus-visible:focus-ring',
            )}
          >
            {label}
          </button>
          <span aria-hidden className="sr-only">
            {raw}
          </span>
        </>
      )
    }
    const open = opener(chip)
    if (chip.kind === 'file' || chip.kind === 'folder' || chip.kind === 'image') {
      const attachment = attachments.find((a) => a.id === chip.attachmentKey)
      return (
        <SentFileChip
          chip={chip}
          raw={raw}
          projectPath={projectPath}
          attachment={attachment}
          open={open}
        />
      )
    }
    // A selection copies what was typed: the chip's look is left out of it, its text is not.
    const githubRef = chip.kind === 'link' ? githubReferenceFromLink(chip.url) : null
    if (githubRef && open) {
      return (
        <>
          <ReferenceHoverCard
            reference={githubRef}
            sessionId={sessionId ?? null}
            side="top"
            sideOffset={6}
            trigger={
              <button
                type="button"
                aria-label={raw}
                onClick={(event) => open(event.currentTarget)}
                className="rounded-[7px] align-middle outline-none select-none focus-visible:focus-ring"
              >
                <ChipView chip={chip} surface />
              </button>
            }
          />
          <span aria-hidden className="sr-only">
            {raw}
          </span>
        </>
      )
    }
    return (
      <>
        {open ? (
          <button
            type="button"
            aria-label={raw}
            title={chip.kind === 'link' ? chip.url : undefined}
            onClick={(event) => open(event.currentTarget)}
            className="rounded-[7px] align-middle outline-none select-none focus-visible:focus-ring"
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
      </>
    )
  }
  return (
    <div data-selectable="">
      <SessionIdContext value={sessionId ?? null}>
        {markdown ? (
          <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}>
            <SentMarkdown text={text} context={context} renderChip={renderChip} />
          </Suspense>
        ) : (
          <SentText text={text} context={context} renderChip={renderChip} />
        )}
      </SessionIdContext>
      {links.dialog}
    </div>
  )
}

type SentMentionChip = Exclude<Chip, { kind: 'command' | 'skill' | 'link' }>

/**
 * A sent user message's file, folder, or image mention chip with desktop hover preview.
 * Clicking retains the existing open behavior while touch devices render the plain chip only.
 */
function SentFileChip({
  chip,
  raw,
  projectPath,
  attachment,
  open,
}: {
  chip: SentMentionChip
  raw: string
  projectPath: string | null
  attachment: Attachment | undefined
  open: ((from: HTMLElement) => void) | null
}) {
  const [hoverOpen, setHoverOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const range = useMemo(() => parseLineRangeText(chip.lines), [chip.lines])
  const attachmentFsPath = attachment?.uri ? fileUrlPath(attachment.uri, hostPlatform()) : null
  const attachmentRelative =
    attachmentFsPath && projectPath ? relativeToRoot(attachmentFsPath, projectPath) : null
  const projectRelative = chip.path ?? attachmentRelative
  const displayPath = projectRelative ?? attachmentFsPath ?? chip.label
  const previewKind = chip.missing
    ? 'missing'
    : chip.kind === 'folder'
      ? 'folder'
      : chip.kind === 'image'
        ? 'image'
        : 'file'
  const source = useMemo<FilePreviewSource | null>(() => {
    if (previewKind === 'folder' || previewKind === 'missing') return null
    if (!projectPath || !projectRelative) return null
    return {
      kind: 'project',
      projectPath,
      path: projectRelative,
      ...(shouldReadAsText(projectRelative, range) && { asText: true }),
    }
  }, [previewKind, projectPath, projectRelative, range])

  const openFromCard = open
    ? () => {
        const from = triggerRef.current
        if (from) open(from)
        else if (projectPath && projectRelative) {
          openFile(projectPath, projectRelative, range?.start ?? null, { preview: true })
        }
      }
    : null

  const trigger = open ? (
    <button
      ref={triggerRef}
      type="button"
      aria-label={raw}
      onClick={(event) => {
        setHoverOpen(false)
        open(event.currentTarget)
      }}
      className="rounded-[7px] align-middle outline-none select-none focus-visible:focus-ring"
    />
  ) : (
    <span aria-hidden className="inline-block align-middle select-none" />
  )

  return (
    <>
      <FileHoverPreview
        source={source}
        path={displayPath}
        range={range}
        kind={previewKind}
        thumb={attachment?.thumb ?? chip.thumb ?? null}
        size={attachment?.size ?? null}
        onOpen={openFromCard}
        open={hoverOpen}
        onOpenChange={setHoverOpen}
        trigger={trigger}
      >
        <ChipView chip={chip} surface />
      </FileHoverPreview>
      <span aria-hidden={open ? true : undefined} className="sr-only">
        {raw}
      </span>
    </>
  )
}

/** A link, an attachment or content Kettu cannot show, as a labelled chip. */
export function RefChip({
  contentRef,
}: {
  contentRef: Exclude<ContentRef, { kind: 'image' | 'audio' | 'video' | 'plugin' }>
}) {
  const link = contentRef.kind === 'link'
  const label =
    contentRef.kind === 'link'
      ? contentRef.name || basename(contentRef.uri)
      : contentRef.kind === 'attachment'
        ? contentRef.attachment.name
        : contentRef.kind === 'terminal' ||
            contentRef.kind === 'page' ||
            contentRef.kind === 'device'
          ? contentRef.name
          : contentRef.label
  return (
    <span
      className="inline-flex h-6 max-w-60 items-center gap-1.5 rounded-md bg-background/60 px-2 text-xs text-muted-foreground shadow-card"
      title={link ? contentRef.uri : label}
    >
      {link &&
        (contentRef.uri.startsWith('file:') ? (
          <HugeiconsIcon
            icon={File01Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3 shrink-0"
          />
        ) : (
          <HugeiconsIcon
            icon={Link01Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3 shrink-0"
          />
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
  const resolve = useSentResolver(attachments, NO_SURFACES, [], text)
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
