import { useEffect, useMemo, useRef } from 'react'
import { FileIcon, FileWarningIcon, XIcon } from 'lucide-react'
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
import { closeFile, type OpenFile } from '@renderer/stores/files'
import { folderOf, nameOf } from './paths'

/** The open file, highlighted on the diffs worker pool, or what stands in for it. */
export function FilePreview({ projectPath, file }: { projectPath: string; file: OpenFile | null }) {
  if (!file) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileIcon />
          </EmptyMedia>
          <EmptyTitle>Open files appear here</EmptyTitle>
          <EmptyDescription>
            Pick a file in the tree, or click a file path in the conversation.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const folder = folderOf(file.path)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-border-soft pr-1 pl-3 text-xs">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={file.path}>
          <span className="shrink-0 font-medium">{nameOf(file.path)}</span>
          {folder && <span className="truncate text-muted-foreground">{folder}</span>}
        </span>
        <CopyButton text={file.path} label="Copy path" />
        <PanelButton label="Close file" onClick={() => closeFile(projectPath)}>
          <XIcon />
        </PanelButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <Body file={file} />
      </div>
    </div>
  )
}

function Body({ file }: { file: OpenFile }) {
  const { content, error } = file
  if (error && !content) return <Notice title="Couldn't open this file" description={error} />
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
    return <Notice title="Binary file" description={`${bytes(content.size)}, not shown.`} />
  }
  if (content.kind === 'too-large') {
    return (
      <Notice
        title="Too large to preview"
        description={`${bytes(content.size)}; the preview shows files up to 1 MB.`}
      />
    )
  }
  return <Code content={content} line={file.line} />
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
      overflow: 'scroll' as const,
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
      const host = scroller.querySelector('diffs-container')
      const row = host?.shadowRoot?.querySelector(`[data-line="${line}"]`)
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: 'center' })
        return
      }
      // Not rendered yet: move to where it should be, then look again.
      scroller.scrollTop = Math.max(0, (line - 1) * LINE_ESTIMATE - scroller.clientHeight / 2)
      if (++tries < 30) frame = requestAnimationFrame(find)
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
