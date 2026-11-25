import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  CodeIcon,
  FileNotFoundIcon,
  FloppyDiskIcon,
  FolderOpenIcon,
  GitCompareIcon,
  Link01Icon,
  MessageAdd01Icon,
  MoreHorizontalIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ChangeStatus } from '@shared/git'
import {
  DOCX_TYPE,
  OFFICE_PREVIEW_LIMIT,
  XLS_TYPE,
  XLSX_TYPE,
  type MediaGrant,
} from '@shared/media'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { emitAppEvent } from '@renderer/app/events'
import {
  PaneContext,
  PaneEmpty,
  PaneIcon,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { panelSession } from '@renderer/stores/view'
import { bytes, clock } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, formatShortcut, isMod, isWeb, isWindows } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { Markdown } from '@renderer/features/session/markdown'
import { playerFailure } from '@renderer/features/session/media/failure'
import { PlayElsewhere, UnsupportedReason } from '@renderer/features/session/media/local-media'
import {
  DEFAULT_PICTURE_SIZE,
  handleZoomKeys,
  usePictureZoom,
  type PictureControls,
} from '@renderer/features/session/media/picture-zoom'
import { playOneAtATime } from '@renderer/features/session/media/playback'
import { imageSurface } from '@renderer/features/session/media/surface'
import { ZoomControls, type ZoomLevel } from '@renderer/features/session/media/zoom-controls'
import type { Size } from '@renderer/features/session/media/zoom'
import { toast } from '@renderer/components/ui/toast'
import { agentName } from '@renderer/stores/agents'
import {
  discardEdits,
  getBuffer,
  isSvgFile,
  keepEdits,
  mediaVersion,
  readAgain,
  renewOpenFile,
  saveFile,
  showMarkdownRendered,
  showSvgSource,
  useFilesStore,
  type OpenFile,
} from '@renderer/stores/files'
import { ChangeBadge } from './change-badge'
import { PreviewFileContext } from './file-refs'
import { PathCopy, PreviewEditToggle } from './file-header'
import { mentionPaths } from './mention-lines'
import { copyPaths } from './operations'
import { openInEditor } from './open-in-editor'
import { nameOf } from './paths'
import type { DocumentFailure } from './document-failure'

const CodeEditor = lazy(() => import('./code-editor'))
const PdfStage = lazy(() => import('./pdf-viewer'))
const WordStage = lazy(() => import('./word-viewer'))
const SheetStage = lazy(() => import('./sheet-viewer'))

/** The picture's controls and zoom, which its stage hands up to the header. */
export interface Picture {
  controls: PictureControls
  zoom: ZoomLevel
  /** The page a document is at, for the header to say. */
  pages?: { current: number; total: number }
}

/** The room a fitted picture leaves on each side of the pane, as it always has. */
const PANE_FIT_MARGIN = 24

/** A file tab's content: its context bar, then the file in the editor or what stands in for it. */
export function FilePreview({
  projectPath,
  panel,
  file,
  change,
  onShowDiff,
}: {
  projectPath: string
  panel: string
  file: OpenFile
  /** The file's uncommitted change, when it has one. */
  change: ChangeStatus | undefined
  /** Shows that change in a diff tab, offered while the file has one. */
  onShowDiff?: () => void
}) {
  const { t } = useTranslation(['files', 'composer'])
  const source = useFilesStore((s) => s.markdownSource)
  const svgSource = useFilesStore((s) => s.svgSource)
  // The picture's own zoom, shown in the bar and turned by the keys; a clip or a text has none.
  const [media, setMedia] = useState<{ path: string; picture: Picture } | null>(null)
  const picture = media?.path === file.path ? media.picture : null
  const onPicture = useCallback((path: string, next: Picture | null) => {
    // A picture leaving clears only its own entry, never the next picture's.
    setMedia((current) =>
      next ? { path, picture: next } : current?.path === path ? null : current,
    )
  }, [])
  const markdown = isMarkdown(file.path) && file.content?.kind === 'text'
  const local = isLocal(projectPath)
  const sessionId = panelSession(panel)
  const mention = (): void => {
    if (!sessionId) return
    const missed = mentionPaths(sessionId, projectPath, [{ path: file.path, folder: false }])
    if (missed === 'no-composer') toast(t('tree.noComposer'))
    else if (missed === 'full') toast(t('composer:attachments.limit'))
  }
  return (
    <div
      data-file-preview=""
      className="flex min-h-0 flex-1 flex-col"
      // Anywhere in the pane, so it still saves after a click on one of the bars' buttons.
      onKeyDown={(event) => {
        if (handleZoomKeys(event, picture?.controls ?? null)) return
        if (!isMod(event) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's')
          return
        event.preventDefault()
        void saveFile(projectPath, file.path)
      }}
    >
      <PaneContext
        tools={
          <>
            {file.dirty && (
              <PanelButton
                label={t('preview.save')}
                shortcut={formatShortcut('Mod+S')}
                onClick={() => void saveFile(projectPath, file.path)}
              >
                <PaneIcon icon={FloppyDiskIcon} />
              </PanelButton>
            )}
            {picture?.pages && (
              <span className="px-1.5 text-xs text-tertiary tabular">
                {t('preview.pageOf', picture.pages)}
              </span>
            )}
            {picture && <ZoomControls zoom={picture.zoom} controls={picture.controls} size="xs" />}
            {markdown && (
              <PreviewEditToggle
                value={rendered(file, source) ? 'preview' : 'edit'}
                onChange={(next) =>
                  next === 'edit'
                    ? useFilesStore.setState({ markdownSource: true })
                    : showMarkdownRendered(projectPath, file.path)
                }
              />
            )}
            {isSvgFile(file.path) && file.content && (
              <PreviewEditToggle
                value={svgSource ? 'edit' : 'preview'}
                onChange={(next) => showSvgSource(next === 'edit')}
              />
            )}
            {onShowDiff && (
              <PanelButton label={t('preview.showChanges')} onClick={onShowDiff}>
                <PaneIcon icon={GitCompareIcon} />
              </PanelButton>
            )}
            {sessionId && !file.agent && (
              <PanelButton label={t('preview.reference')} onClick={mention}>
                <PaneIcon icon={MessageAdd01Icon} />
              </PanelButton>
            )}
            {local && (
              <PanelButton
                label={t('panel.openInEditor')}
                onClick={() => openOutside(openInEditor, projectPath, file.path)}
              >
                <PaneIcon icon={CodeIcon} />
              </PanelButton>
            )}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          aria-label={t('panel.more')}
                          className="kp-tool app-region-no-drag"
                        />
                      }
                    />
                  }
                >
                  <PaneIcon icon={MoreHorizontalIcon} />
                </TooltipTrigger>
                <TooltipContent>{t('panel.more')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => copyPaths(projectPath, [file.path], false)}>
                  <PaneIcon icon={Link01Icon} size={16} />
                  {t('tree.copyPath')}
                </DropdownMenuItem>
                {!file.agent && (
                  <DropdownMenuItem onClick={() => copyPaths(projectPath, [file.path], true)}>
                    <PaneIcon icon={Link01Icon} size={16} />
                    {t('tree.copyRelativePath')}
                  </DropdownMenuItem>
                )}
                {local && (
                  <DropdownMenuItem
                    onClick={() => openOutside(window.kettu.shell.showItem, projectPath, file.path)}
                  >
                    <PaneIcon icon={FolderOpenIcon} size={16} />
                    {t('preview.showIn', { name: fileManagerName() })}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <PathCopy path={file.path} />
        {change && <ChangeBadge status={change} />}
      </PaneContext>
      <Notes projectPath={projectPath} file={file} />
      <div className="kp-doc__body">
        <Body projectPath={projectPath} panel={panel} file={file} onPicture={onPicture} />
      </div>
    </div>
  )
}

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

/** Markdown shows rendered unless the source was chosen or a reference asks for a line. */
const rendered = (file: OpenFile, source: boolean) =>
  isMarkdown(file.path) && !source && file.line === null

/** The text with its unsaved edits, when it has any. */
function editedText(projectPath: string, file: OpenFile): string | null {
  const buffer = getBuffer(projectPath, file.path)
  return file.dirty && buffer ? buffer.state.sliceDoc() : null
}

/** Bars under the header for what the open file's edits need to know. */
function Notes({ projectPath, file }: { projectPath: string; file: OpenFile }) {
  const { t } = useTranslation('files')
  // A read that failed after the file showed: what shows is what it was.
  if (file.error && file.content) {
    return (
      <Bar tone="error">
        <span className="min-w-0 flex-1">
          {file.missing ? t('preview.missing') : t('preview.readFailed', { message: file.error })}
        </span>
        <NextStep projectPath={projectPath} file={file} small />
      </Bar>
    )
  }
  if (file.changedOnDisk) {
    return (
      <Bar tone="notice">
        <span className="min-w-0 flex-1">{t('preview.changedOnDisk')}</span>
        <button
          type="button"
          className="kp-btn kp-btn--sm"
          onClick={(event) => {
            backToEditor(event.currentTarget)
            discardEdits(projectPath, file.path)
          }}
        >
          {t('preview.reload')}
        </button>
        <button
          type="button"
          className="kp-btn kp-btn--sm"
          onClick={(event) => {
            backToEditor(event.currentTarget)
            keepEdits(projectPath, file.path)
          }}
        >
          {t('preview.keepMine')}
        </button>
      </Bar>
    )
  }
  if (file.saveError) {
    return (
      <Bar tone="error">
        <span className="min-w-0 flex-1">
          {t('preview.saveFailed', { message: file.saveError })}
        </span>
      </Bar>
    )
  }
  if (file.agent) {
    const agent = agentName(file.agent.agentId, hostOfPath(projectPath))
    return (
      <Bar tone="muted">
        <span className="min-w-0 flex-1">{t('preview.agentFile', { agent })}</span>
      </Bar>
    )
  }
  if (file.content?.kind === 'text' && !file.content.editable) {
    return (
      <Bar tone="muted">
        <span className="min-w-0 flex-1">{t('preview.readOnly')}</span>
      </Bar>
    )
  }
  return null
}

/** A failed read's way on: a file gone from disk closes, any other read is tried again. */
function NextStep({
  projectPath,
  file,
  small = false,
}: {
  projectPath: string
  file: OpenFile
  small?: boolean
}) {
  const { t } = useTranslation(['files', 'common'])
  return (
    <button
      type="button"
      className={small ? 'kp-btn kp-btn--sm' : 'kp-btn'}
      onClick={() =>
        // The row closes its selected tab, which is this file's.
        file.missing ? emitAppEvent({ kind: 'close-side-tab' }) : readAgain(projectPath, file.path)
      }
    >
      {file.missing ? t('preview.closeTab') : t('common:actions.retry')}
    </button>
  )
}

/** Editors and the file manager reach files on this computer only. */
const isLocal = (projectPath: string): boolean => !isWeb && hostOfPath(projectPath) === null

/** The file's own path on this computer, from its path in the project; an agent's is absolute. */
function pathOnDisk(projectPath: string, path: string): string {
  if (/^(?:\/|[a-z]:[\\/])/i.test(path)) return path
  const sep = isWindows ? '\\' : '/'
  return `${projectPath.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`
}

/** Shows the file in the editor or the file manager; a failure says why in a toast. */
function openOutside(open: (path: string) => Promise<void>, projectPath: string, path: string) {
  open(pathOnDisk(projectPath, path)).catch((failure: unknown) => toast(errorMessage(failure)))
}

/** The bar goes once answered, and its button with it, so the text takes the focus back. */
function backToEditor(from: HTMLElement): void {
  from.closest('[data-file-preview]')?.querySelector<HTMLElement>('.cm-content')?.focus()
}

function Bar({ tone, children }: { tone: 'notice' | 'error' | 'muted'; children: ReactNode }) {
  return (
    <div role={tone === 'muted' ? undefined : 'status'} className="kp-doc__note" data-tone={tone}>
      {children}
    </div>
  )
}

function Body({
  projectPath,
  panel,
  file,
  onPicture,
}: {
  projectPath: string
  panel: string
  file: OpenFile
  onPicture: (path: string, picture: Picture | null) => void
}) {
  const { t } = useTranslation('files')
  const source = useFilesStore((s) => s.markdownSource)
  const { content, error } = file
  const local = isLocal(projectPath)
  if (error && !content) {
    return (
      <Notice title={t('preview.openFailed')} description={error}>
        <NextStep projectPath={projectPath} file={file} />
      </Notice>
    )
  }
  if (!content) return <Lines />
  if (content.kind === 'binary') {
    return (
      <Notice
        title={t('preview.binaryTitle')}
        description={t('preview.binaryDescription', { size: bytes(content.size) })}
      >
        {local && (
          <button
            type="button"
            className="kp-btn"
            onClick={() => openOutside(window.kettu.shell.showItem, projectPath, file.path)}
          >
            {t('preview.showIn', { name: fileManagerName() })}
          </button>
        )}
      </Notice>
    )
  }
  if (content.kind === 'too-large') {
    return (
      <Notice
        title={t('preview.tooLargeTitle')}
        description={t('preview.tooLargeDescription', {
          size: bytes(content.size),
          limit: bytes(content.limit),
        })}
      >
        {local && (
          <button
            type="button"
            className="kp-btn"
            onClick={() => openOutside(openInEditor, projectPath, file.path)}
          >
            {t('panel.openInEditor')}
          </button>
        )}
      </Notice>
    )
  }
  if (content.kind === 'media' && content.grant.kind === 'document') {
    return (
      <FileDocument
        key={`${content.path}\0${mediaVersion(content.grant.url)}`}
        projectPath={projectPath}
        panel={panel}
        path={content.path}
        grant={content.grant}
        onPicture={onPicture}
      />
    )
  }
  if (content.kind === 'media') {
    return (
      <FileMedia
        // A file changed on disk starts over; a fresh grant for the same file does not.
        key={`${content.path}\0${mediaVersion(content.grant.url)}`}
        projectPath={projectPath}
        path={content.path}
        grant={content.grant}
        onPicture={onPicture}
      />
    )
  }
  if (rendered(file, source)) {
    return (
      <RenderedMarkdown
        key={`${projectPath}\0${panel}\0${file.path}`}
        viewKey={`${projectPath}\0${panel}\0${file.path}`}
        text={editedText(projectPath, file) ?? content.text}
        // The agent's own folder is read without media, so its images stay text.
        projectPath={file.agent ? null : projectPath}
        path={file.path}
      />
    )
  }
  return (
    <Suspense fallback={<Lines />}>
      <CodeEditor projectPath={projectPath} panel={panel} file={file} content={content} />
    </Suspense>
  )
}

const markdownScroll = new Map<string, number>()

function RenderedMarkdown({
  viewKey,
  text,
  projectPath,
  path,
}: {
  viewKey: string
  text: string
  /** The project the file is in, whose images it shows; null for a file outside one. */
  projectPath: string | null
  path: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const preview = useMemo(() => (projectPath ? { projectPath, path } : null), [projectPath, path])
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = markdownScroll.get(viewKey) ?? 0
  }, [viewKey])
  return (
    <div
      ref={box}
      className="absolute inset-0 overflow-y-auto overscroll-contain px-6 py-5"
      data-selectable=""
      onScroll={(event) => markdownScroll.set(viewKey, event.currentTarget.scrollTop)}
    >
      <PreviewFileContext value={preview}>
        <Markdown markdown={text} className="mx-auto max-w-[50em]" />
      </PreviewFileContext>
    </div>
  )
}

export function Lines() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-2/5" />
    </div>
  )
}

/**
 * A document from the media scheme: a PDF's or a Word file's pages, or a workbook's sheets, on a
 * stage of their own. One that is protected, damaged or too large to show says why and offers the
 * file to another app; one that cannot be read is asked for again once first, since main may have
 * dropped its grant.
 */
function FileDocument({
  projectPath,
  panel,
  path,
  grant,
  onPicture,
}: {
  projectPath: string
  panel: string
  path: string
  grant: MediaGrant
  onPicture: (path: string, picture: Picture | null) => void
}) {
  const { t } = useTranslation('files')
  const [renewed, setRenewed] = useState(false)
  const [failure, setFailure] = useState<'encrypted' | 'damaged' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const failed = (reason: DocumentFailure) => {
    if (reason === 'unreadable' && !renewed) {
      setRenewed(true)
      renewOpenFile(projectPath, path)
    } else setFailure(reason === 'encrypted' ? 'encrypted' : 'damaged')
  }
  const kind = documentKind(grant.mimeType)
  if (!kind) {
    return (
      <Notice
        title={t('preview.binaryTitle')}
        description={t('preview.binaryDescription', { size: bytes(grant.size) })}
      />
    )
  }
  const tooLarge = grant.tooLarge || (kind !== 'pdf' && grant.size > OFFICE_PREVIEW_LIMIT)
  if (tooLarge || failure) {
    const [title, text] = tooLarge
      ? tooLargeText(t, kind, grant.size)
      : failureText(t, kind, failure === 'encrypted')
    return (
      <PaneEmpty
        className="absolute inset-0"
        icon={<PaneIcon icon={FileNotFoundIcon} size={20} />}
        title={title}
        text={text}
      >
        <span className="mt-3 flex flex-wrap justify-center gap-1.5">
          <PlayElsewhere url={grant.url} projectPath={projectPath} onError={setError} />
        </span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </PaneEmpty>
    )
  }
  const stage = {
    viewKey: `${projectPath}\0${panel}\0${path}`,
    url: grant.url,
    name: nameOf(path),
    onFailed: failed,
  }
  return (
    <Suspense fallback={<Lines />}>
      {kind === 'pdf' && <PdfStage {...stage} path={path} onPicture={onPicture} />}
      {kind === 'word' && <WordStage {...stage} path={path} onPicture={onPicture} />}
      {kind === 'sheet' && <SheetStage {...stage} />}
    </Suspense>
  )
}

type DocumentKind = 'pdf' | 'word' | 'sheet'

function documentKind(mimeType: MediaGrant['mimeType']): DocumentKind | null {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === DOCX_TYPE) return 'word'
  return mimeType === XLSX_TYPE || mimeType === XLS_TYPE ? 'sheet' : null
}

/** The title and the words under it for a document too large to preview. */
function tooLargeText(t: TFunction<'files'>, kind: DocumentKind, size: number): [string, string] {
  if (kind === 'pdf') return [t('preview.mediaTooLargeTitle'), bytes(size)]
  const description = t('preview.tooLargeDescription', {
    size: bytes(size),
    limit: bytes(OFFICE_PREVIEW_LIMIT),
  })
  return [t('preview.tooLargeTitle'), description]
}

/** The title and the words under it for a document that is protected or cannot be read. */
function failureText(
  t: TFunction<'files'>,
  kind: DocumentKind,
  protectedFile: boolean,
): [string, string] {
  if (kind === 'pdf') {
    return protectedFile
      ? [t('preview.pdfEncryptedTitle'), t('preview.pdfEncryptedDescription')]
      : [t('preview.pdfFailedTitle'), t('preview.pdfFailedDescription')]
  }
  if (kind === 'word') {
    return protectedFile
      ? [t('preview.wordEncryptedTitle'), t('preview.wordEncryptedDescription')]
      : [t('preview.wordFailedTitle'), t('preview.wordFailedDescription')]
  }
  return protectedFile
    ? [t('preview.sheetEncryptedTitle'), t('preview.sheetEncryptedDescription')]
    : [t('preview.sheetFailedTitle'), t('preview.sheetFailedDescription')]
}

/**
 * A media file from the media scheme, centred: a picture on a stage of its own, where it zooms and
 * pans as it does in the viewer, over squares that show its transparency; a clip fitted to the
 * pane, and a sound, with Chromium's controls. Its pixel size, length and file size show under it.
 */
function FileMedia({
  projectPath,
  path,
  grant,
  onPicture,
}: {
  projectPath: string
  path: string
  grant: MediaGrant
  onPicture: (path: string, picture: Picture | null) => void
}) {
  const { t } = useTranslation('files')
  const [size, setSize] = useState<Size | null>(
    grant.width && grant.height ? { width: grant.width, height: grant.height } : null,
  )
  const [seconds, setSeconds] = useState<number | null>(null)
  // A grant main dropped fails as a file it cannot play does, so one fresh grant comes first.
  const [renewed, setRenewed] = useState(false)
  const [failure, setFailure] = useState<{ message: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(playOneAtATime, [])
  const name = nameOf(path)

  const failed = (message: string | null) => {
    if (renewed) setFailure({ message })
    else {
      setRenewed(true)
      renewOpenFile(projectPath, path)
    }
  }
  if (failure || grant.tooLarge) {
    return (
      <PaneEmpty
        className="absolute inset-0"
        icon={<PaneIcon icon={FileNotFoundIcon} size={20} />}
        title={
          failure?.message ? (
            t('preview.openFailed')
          ) : grant.tooLarge ? (
            t('preview.mediaTooLargeTitle')
          ) : (
            <UnsupportedReason kind={grant.kind} />
          )
        }
        text={failure?.message ?? bytes(grant.size)}
      >
        <span className="mt-3 flex flex-wrap justify-center gap-1.5">
          <PlayElsewhere url={grant.url} projectPath={projectPath} onError={setError} />
        </span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </PaneEmpty>
    )
  }

  const meta = (
    <p className="shrink-0 text-center text-xs text-tertiary tabular">
      {[
        size && `${size.width} × ${size.height}`,
        seconds !== null && Number.isFinite(seconds) ? clock(seconds) : null,
        bytes(grant.size),
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>
  )
  if (grant.kind === 'audio') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-6">
        <audio
          src={grant.url}
          controls
          controlsList="nodownload"
          preload="metadata"
          aria-label={name}
          onLoadedMetadata={(event) => setSeconds(event.currentTarget.duration)}
          onError={(event) => failed(playerFailure(event.currentTarget))}
          className="w-full max-w-[420px]"
        />
        {meta}
      </div>
    )
  }
  return (
    <div className="absolute inset-0 flex flex-col">
      {grant.kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <video
            src={grant.url}
            controls
            controlsList="nodownload"
            preload="metadata"
            aria-label={name}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight, duration } = event.currentTarget
              // Chromium loads some formats, such as ProRes, with sound and a picture of 0 x 0.
              if (videoWidth === 0 || videoHeight === 0) {
                failed(null)
                return
              }
              setSize({ width: videoWidth, height: videoHeight })
              setSeconds(duration)
            }}
            onError={(event) => failed(playerFailure(event.currentTarget))}
            className="max-h-full max-w-full"
          />
        </div>
      ) : (
        <PictureStage
          path={path}
          url={grant.url}
          name={name}
          onSize={setSize}
          onFailed={() => failed(null)}
          onPicture={onPicture}
        />
      )}
      <div className="pb-3">{meta}</div>
    </div>
  )
}

/**
 * A picture on a stage of the space above its facts, which zooms and pans as the viewer's does:
 * the same gestures, the same fit margin, and a hairline edge that stays a hairline.
 */
function PictureStage({
  path,
  url,
  name,
  onSize,
  onFailed,
  onPicture,
}: {
  path: string
  url: string
  name: string
  onSize: (size: Size) => void
  onFailed: () => void
  onPicture: (path: string, picture: Picture | null) => void
}) {
  const [natural, setNatural] = useState<Size | null>(null)
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const stageRef = useCallback((el: HTMLDivElement | null) => setElement(el), [])
  const { picture, controls, zoom, zoomed, dragging } = usePictureZoom({
    natural,
    stage,
    element,
    margin: PANE_FIT_MARGIN,
    edge: true,
  })

  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  useEffect(() => {
    if (controls && zoom) onPicture(path, { controls, zoom })
  }, [path, controls, zoom, onPicture])
  useEffect(
    () => () => {
      onPicture(path, null)
    },
    [path, onPicture],
  )

  return (
    <div
      ref={stageRef}
      tabIndex={0}
      role="group"
      aria-label={name}
      onPointerDown={(event) => event.currentTarget.focus()}
      className="relative min-h-0 flex-1 overflow-hidden outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    >
      <img
        ref={picture}
        src={url}
        alt={name}
        decoding="async"
        draggable={false}
        onLoad={(event) => {
          const el = event.currentTarget
          el.decode().then(
            () => {
              const size =
                el.naturalWidth > 0 && el.naturalHeight > 0
                  ? { width: el.naturalWidth, height: el.naturalHeight }
                  : DEFAULT_PICTURE_SIZE
              setNatural(size)
              onSize(size)
            },
            () => onFailed(),
          )
        }}
        onError={onFailed}
        style={
          natural
            ? {
                width: natural.width,
                height: natural.height,
                marginLeft: -natural.width / 2,
                marginTop: -natural.height / 2,
              }
            : { visibility: 'hidden' }
        }
        className={cn(
          'absolute top-1/2 left-1/2 max-w-none select-none',
          imageSurface({ path }) === 'canvas' ? 'bg-canvas' : 'bg-card checkerboard',
          zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
        )}
      />
    </div>
  )
}

export function Notice({
  title,
  description,
  children,
}: {
  title: string
  description: string
  /** Its next step, a button. */
  children?: ReactNode
}) {
  return (
    <PaneEmpty
      className="absolute inset-0"
      icon={<PaneIcon icon={FileNotFoundIcon} size={20} />}
      title={title}
      text={description}
    >
      {children}
    </PaneEmpty>
  )
}
