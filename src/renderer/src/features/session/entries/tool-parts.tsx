// The pieces of a tool call that its row, its waiting card and its settled card share.

import {
  ArrowRightLeftIcon,
  BrainIcon,
  FileTextIcon,
  FilePenIcon,
  GlobeIcon,
  RepeatIcon,
  SearchIcon,
  SquareTerminalIcon,
  TrashIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolContent, ToolKind } from '@shared/thread'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, dirname } from '@renderer/lib/format'
import { Clamp } from '../clamp'
import { Markdown } from '../markdown'
import { CarriedImage } from '../media/carried-image'
import { CarriedMedia } from '../media/carried-media'
import { EntryIdContext, SessionIdContext } from '../media/grants'
import { LocalMedia } from '../media/local-media'
import { DiffBlock } from './diff-block'
import type { toolLabel } from './helpers'

export const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: FileTextIcon,
  edit: FilePenIcon,
  delete: TrashIcon,
  move: ArrowRightLeftIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  switch_mode: RepeatIcon,
  other: WrenchIcon,
}

/** Paths keep their file name visible: only the folder part truncates. */
export function Target({ label }: { label: ReturnType<typeof toolLabel> }) {
  const target = label.target ?? ''
  const folder = label.kind === 'path' ? dirname(target) : ''
  const text =
    label.kind === 'path' ? (
      <span className="flex min-w-0 font-mono text-xs text-secondary">
        {/* An empty truncating span would put the row's baseline at its bottom edge. */}
        {folder && <span className="truncate">{folder}</span>}
        <span className="shrink-0">{basename(target)}</span>
      </span>
    ) : label.kind === 'command' ? (
      <span className="min-w-0 truncate font-mono text-xs text-secondary">
        {target.split('\n')[0]}
      </span>
    ) : (
      <span className="min-w-0 truncate">{target}</span>
    )
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0" />}>{text}</TooltipTrigger>
      <TooltipContent className="max-w-[480px] font-mono text-meta break-all whitespace-pre-wrap">
        {target}
      </TooltipContent>
    </Tooltip>
  )
}

/** The tallest an image shows in a tool call's details. */
const MEDIA_IMAGE_HEIGHT = 160

export function ContentBlock({
  sessionId,
  entryId,
  index,
  content,
  projectPath,
}: {
  sessionId: string
  entryId: string
  /** Its place among the call's content, by which the viewer knows a picture. */
  index: number
  content: ToolContent
  projectPath: string
}) {
  const { t } = useTranslation('session')
  switch (content.type) {
    case 'markdown':
      return (
        <div data-selectable="">
          <Clamp maxHeight={320} more={t('tool.showAll')}>
            <Markdown markdown={content.markdown} className="markdown-compact" />
          </Clamp>
        </div>
      )
    case 'diff':
      return <DiffBlock diff={content} projectPath={projectPath} />
    case 'ref':
      if (content.ref.kind === 'image') {
        return (
          <CarriedImage
            sessionId={sessionId}
            entryId={entryId}
            index={index}
            mimeType={content.ref.mimeType}
            data={content.ref.data}
            className="max-h-40 max-w-full self-start rounded-lg shadow-card"
          />
        )
      }
      if (content.ref.kind === 'audio' || content.ref.kind === 'video') {
        return (
          <CarriedMedia
            sessionId={sessionId}
            entryId={entryId}
            index={index}
            carried={content.ref}
          />
        )
      }
      return (
        <div className="text-xs text-muted-foreground">
          {content.ref.kind === 'link'
            ? content.ref.name || content.ref.uri
            : content.ref.kind === 'unsupported'
              ? content.ref.label
              : content.ref.attachment.name}
        </div>
      )
  }
}

/** Pictures a tool call made or read, under its details. */
export function ToolMedia({
  sessionId,
  entryId,
  media,
}: {
  sessionId: string
  entryId: string
  media: string[]
}) {
  if (media.length === 0) return null
  return (
    <SessionIdContext value={sessionId}>
      <EntryIdContext value={entryId}>
        <div className="flex flex-col items-start gap-3 empty:hidden">
          {media.map((path) => (
            <LocalMedia key={path} path={path} imageHeight={MEDIA_IMAGE_HEIGHT} />
          ))}
        </div>
      </EntryIdContext>
    </SessionIdContext>
  )
}
