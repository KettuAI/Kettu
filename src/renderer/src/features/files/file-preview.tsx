import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BookOpenIcon, CodeIcon, FileIcon, FileWarningIcon, SaveIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { bytes, clock } from '@renderer/lib/format'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { Markdown } from '@renderer/features/session/markdown'
import { playerFailure } from '@renderer/features/session/media/failure'
import { PlayElsewhere, UnsupportedReason } from '@renderer/features/session/media/local-media'
import { playOneAtATime } from '@renderer/features/session/media/playback'
import {
  buffers,
  closeFile,
  discardEdits,
  isSvgFile,
  keepEdits,
  mediaVersion,
  renewOpenFile,
  saveFile,
  showSvgSource,
  useFilesStore,
  type OpenFile,
} from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import { folderOf, nameOf } from './paths'

const CodeEditor = lazy(() => import('./code-editor'))

/** The open file, in the editor, or what stands in for it. */
export function FilePreview({ projectPath, file }: { projectPath: string; file: OpenFile | null }) {
  const { t } = useTranslation('files')
  const source = useFilesStore((s) => s.markdownSource)
  const svgSource = useFilesStore((s) => s.svgSource)
  if (!file) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileIcon />
          </EmptyMedia>
          <EmptyTitle>{t('preview.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('preview.emptyDescription')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const folder = folderOf(file.path)
  return (
    <div
      data-file-preview=""
      className="flex h-full min-h-0 flex-col bg-background"
      // Anywhere in the pane, so it still saves after a click on one of the bars' buttons.
      onKeyDown={(event) => {
        if (!isMod(event) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's')
          return
        event.preventDefault()
        void saveFile(projectPath)
      }}
    >
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-subtle pr-1 pl-3 text-xs">
        <FileTypeIcon path={file.path} className="mr-1 size-4" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={file.path}>
          <span className="shrink-0 font-medium">{nameOf(file.path)}</span>
          {file.dirty && (
            <span
              role="img"
              aria-label={t('preview.unsaved')}
              className="size-1.5 shrink-0 self-center rounded-full bg-primary"
            />
          )}
          {folder && <span className="truncate text-tertiary">{folder}</span>}
        </span>
        {file.dirty && (
          <PanelButton
            label={t('preview.save')}
            shortcut={formatShortcut('Mod+S')}
            onClick={() => void saveFile(projectPath)}
          >
            <SaveIcon />
          </PanelButton>
        )}
        {isMarkdown(file.path) && file.content?.kind === 'text' && (
          <PanelButton
            label={rendered(file, source) ? t('preview.showSource') : t('preview.showRendered')}
            onClick={() =>
              useFilesStore.setState((s) =>
                rendered(file, source)
                  ? { markdownSource: true }
                  : {
                      markdownSource: false,
                      open: { ...s.open, [projectPath]: { ...file, line: null } },
                    },
              )
            }
          >
            {rendered(file, source) ? <CodeIcon /> : <BookOpenIcon />}
          </PanelButton>
        )}
        {isSvgFile(file.path) && file.content && (
          <PanelButton
            label={svgSource ? t('preview.showRendered') : t('preview.showSource')}
            onClick={() => showSvgSource(!svgSource)}
          >
            {svgSource ? <BookOpenIcon /> : <CodeIcon />}
          </PanelButton>
        )}
        <CopyButton text={file.path} label={t('preview.copyPath')} />
        <PanelButton label={t('preview.closeFile')} onClick={() => closeFile(projectPath)}>
          <XIcon />
        </PanelButton>
      </div>
      <Notes projectPath={projectPath} file={file} />
      <div className="relative min-h-0 flex-1">
        <Body projectPath={projectPath} file={file} />
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
  const buffer = buffers.get(projectPath)
  return file.dirty && buffer?.path === file.path ? buffer.state.sliceDoc() : null
}

/** Bars under the header for what the open file's edits need to know. */
function Notes({ projectPath, file }: { projectPath: string; file: OpenFile }) {
  const { t } = useTranslation('files')
  if (file.changedOnDisk) {
    return (
      <Bar tone="notice">
        <span className="min-w-0 flex-1">{t('preview.changedOnDisk')}</span>
        <Button
          size="xs"
          variant="outline"
          onClick={(event) => {
            backToEditor(event.currentTarget)
            discardEdits(projectPath)
          }}
        >
          {t('preview.reload')}
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={(event) => {
            backToEditor(event.currentTarget)
            keepEdits(projectPath)
          }}
        >
          {t('preview.keepMine')}
        </Button>
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
  if (file.content?.kind === 'text' && !file.content.editable) {
    return (
      <Bar tone="muted">
        <span className="min-w-0 flex-1">{t('preview.readOnly')}</span>
      </Bar>
    )
  }
  return null
}

/** The bar goes once answered, and its button with it, so the text takes the focus back. */
function backToEditor(from: HTMLElement): void {
  from.closest('[data-file-preview]')?.querySelector<HTMLElement>('.cm-content')?.focus()
}

function Bar({ tone, children }: { tone: 'notice' | 'error' | 'muted'; children: ReactNode }) {
  return (
    <div
      role={tone === 'muted' ? undefined : 'status'}
      className={cn(
        'flex min-h-row shrink-0 items-center gap-1.5 border-b border-subtle py-1 pr-1.5 pl-3 text-xs',
        tone === 'notice' && 'bg-subtle text-secondary',
        tone === 'error' && 'bg-danger-tint text-danger',
        tone === 'muted' && 'text-tertiary',
      )}
    >
      {children}
    </div>
  )
}

function Body({ projectPath, file }: { projectPath: string; file: OpenFile }) {
  const { t } = useTranslation('files')
  const source = useFilesStore((s) => s.markdownSource)
  const { content, error } = file
  if (error && !content) return <Notice title={t('preview.openFailed')} description={error} />
  if (!content) return <Lines />
  if (content.kind === 'binary') {
    return (
      <Notice
        title={t('preview.binaryTitle')}
        description={t('preview.binaryDescription', { size: bytes(content.size) })}
      />
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
      />
    )
  }
  if (rendered(file, source)) {
    return (
      <div
        className="absolute inset-0 overflow-y-auto overscroll-contain px-6 py-5"
        data-selectable=""
      >
        <Markdown
          markdown={editedText(projectPath, file) ?? content.text}
          className="mx-auto max-w-[50em]"
        />
      </div>
    )
  }
  return (
    <Suspense fallback={<Lines />}>
      <CodeEditor projectPath={projectPath} file={file} content={content} />
    </Suspense>
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

type Size = { width: number; height: number }

/**
 * A media file from the media scheme, centred: a picture at its own size, or fitted to the pane
 * when larger, over squares that show its transparency; a clip the same way, and a sound, with
 * Chromium's controls. Its pixel size, length and file size show under it.
 */
function FileMedia({
  projectPath,
  path,
  grant,
}: {
  projectPath: string
  path: string
  grant: MediaGrant
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
      renewOpenFile(projectPath)
    }
  }
  if (failure?.message) {
    return <Notice title={t('preview.openFailed')} description={failure.message} />
  }
  if (failure) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileWarningIcon />
          </EmptyMedia>
          <EmptyTitle>
            <UnsupportedReason kind={grant.kind} />
          </EmptyTitle>
          <EmptyDescription>{bytes(grant.size)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <span className="flex flex-wrap justify-center gap-1.5">
            <PlayElsewhere url={grant.url} onError={setError} />
          </span>
          {error && <span className="text-xs text-danger">{error}</span>}
        </EmptyContent>
      </Empty>
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {grant.kind === 'video' ? (
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
        ) : (
          <img
            src={grant.url}
            alt={name}
            draggable={false}
            decoding="async"
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) {
                setSize({ width: naturalWidth, height: naturalHeight })
              }
            }}
            onError={() => failed(null)}
            className="max-h-full max-w-full checkerboard object-contain shadow-[0_0_0_var(--hairline)_var(--border-default)]"
          />
        )}
      </div>
      <div className="pb-3">{meta}</div>
    </div>
  )
}

export function Notice({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarningIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
