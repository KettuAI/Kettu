import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpenIcon, CodeIcon, FileIcon, FileWarningIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { File, Virtualizer, WorkerPoolContext } from '@pierre/diffs/react'
import type { FileContent } from '@shared/files'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { codeTheme, diffsPool } from '@renderer/features/session/markdown/diff-pool'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { useDark } from '@renderer/hooks/use-dark'
import { bytes } from '@renderer/lib/format'
import { Markdown } from '@renderer/features/session/markdown'
import { closeFile, useFilesStore, type OpenFile } from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import { folderOf, nameOf } from './paths'

/** The open file, highlighted on the diffs worker pool, or what stands in for it. */
export function FilePreview({ projectPath, file }: { projectPath: string; file: OpenFile | null }) {
  const { t } = useTranslation('files')
  const source = useFilesStore((s) => s.markdownSource)
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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-border-soft pr-1 pl-3 text-xs">
        <FileTypeIcon path={file.path} className="mr-1 size-4" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={file.path}>
          <span className="shrink-0 font-medium">{nameOf(file.path)}</span>
          {folder && <span className="truncate text-muted-foreground">{folder}</span>}
        </span>
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
        <CopyButton text={file.path} label={t('preview.copyPath')} />
        <PanelButton label={t('preview.closeFile')} onClick={() => closeFile(projectPath)}>
          <XIcon />
        </PanelButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <Body file={file} />
      </div>
    </div>
  )
}

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

/** Markdown shows rendered unless the source was chosen or a reference asks for a line. */
const rendered = (file: OpenFile, source: boolean) =>
  isMarkdown(file.path) && !source && file.line === null

function Body({ file }: { file: OpenFile }) {
  const { t } = useTranslation('files')
  const source = useFilesStore((s) => s.markdownSource)
  const { content, error } = file
  if (error && !content) return <Notice title={t('preview.openFailed')} description={error} />
  if (!content) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    )
  }
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
  if (content.kind === 'image') return <Picture key={content.path} content={content} />
  if (rendered(file, source)) {
    return (
      <div
        className="absolute inset-0 overflow-y-auto overscroll-contain px-6 py-5"
        data-selectable=""
      >
        <Markdown markdown={content.text} className="mx-auto max-w-[42em]" />
      </div>
    )
  }
  return <Code content={content} line={file.line} />
}

/**
 * A picture at its own size, or fitted to the pane when larger, over squares that show its
 * transparency, with its pixel size and file size under it.
 */
function Picture({ content }: { content: Extract<FileContent, { kind: 'image' }> }) {
  const { t } = useTranslation('files')
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const src = useMemo(() => `data:${content.mimeType};base64,${content.data}`, [content])
  if (failed) {
    return (
      <Notice
        title={t('preview.imageFailedTitle')}
        description={t('preview.imageFailedDescription', { size: bytes(content.size) })}
      />
    )
  }
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <img
          src={src}
          alt={nameOf(content.path)}
          draggable={false}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
          className="max-h-full max-w-full checkerboard object-contain shadow-[0_0_0_var(--hairline)_var(--border)]"
        />
      </div>
      <p className="shrink-0 pb-3 text-center text-xs text-muted-foreground tabular">
        {natural && `${natural.width} × ${natural.height} · `}
        {bytes(content.size)}
      </p>
    </div>
  )
}

function Notice({ title, description }: { title: string; description: string }) {
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

function Code({
  content,
  line,
}: {
  content: Extract<FileContent, { kind: 'text' }>
  line: number | null
}) {
  const dark = useDark()
  const box = useRef<HTMLDivElement>(null)
  const file = useMemo(
    () => ({ name: content.path, contents: content.text }),
    [content.path, content.text],
  )
  const options = useMemo(
    () => ({
      theme: codeTheme,
      themeType: dark ? ('dark' as const) : ('light' as const),
      overflow: 'wrap' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
    }),
    [dark],
  )
  const selected = useMemo(() => (line ? { start: line, end: line } : null), [line])

  // Brings the line into view once it is rendered; the virtualizer renders it only near the view.
  useEffect(() => {
    const scroller = box.current?.firstElementChild
    if (!line || !(scroller instanceof HTMLElement)) return
    let frame = 0
    let tries = 0
    const find = () => {
      const root = scroller.querySelector('diffs-container')?.shadowRoot
      const row = root?.querySelector(`[data-line="${line}"]`)
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: 'center' })
        return
      }
      // Not rendered yet: move to where it should be, then, since wrapped lines differ in height,
      // step toward it from the lines that are rendered.
      const shown = Array.from(root?.querySelectorAll('[data-line]') ?? [], (el) =>
        Number(el.getAttribute('data-line')),
      )
      if (tries === 0 || shown.length === 0) {
        scroller.scrollTop = Math.max(0, (line - 1) * LINE_ESTIMATE - scroller.clientHeight / 2)
      } else {
        scroller.scrollTop += (line > Math.max(...shown) ? 1 : -1) * scroller.clientHeight
      }
      if (++tries < 60) frame = requestAnimationFrame(find)
    }
    frame = requestAnimationFrame(find)
    return () => cancelAnimationFrame(frame)
  }, [line, content.path])

  return (
    <div ref={box} className="absolute inset-0">
      <WorkerPoolContext.Provider value={diffsPool}>
        <Virtualizer className="h-full overflow-auto">
          <File file={file} options={options} selectedLines={selected} className="file-preview" />
        </Virtualizer>
      </WorkerPoolContext.Provider>
    </div>
  )
}

// The diffs library's estimate for a row before it is measured.
const LINE_ESTIMATE = 20
