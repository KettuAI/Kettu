import type { ComponentProps, MouseEvent } from 'react'
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '@shared/thread'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { cn } from '@renderer/lib/utils'
import { cutName } from './cut-name'

/** What a tile shows, the same in the composer and in the thread. */
export interface TileView {
  name: string
  kind: Attachment['type']
  thumb: string | null
  status: 'adding' | 'ready' | 'failed'
  /** Under the name of a tile without a picture: its size, or what went wrong. */
  detail: string | null
  /** The tooltip: the name and size, and how the agent gets it. */
  tooltip: string
  /** It goes another way than its kind suggests, as an image to an agent without image input. */
  warn: boolean
}

/**
 * A 112 px attachment tile: an image's thumbnail, or a file's name and size. See attachments in
 * the design system.
 */
export function AttachmentTile({
  view,
  onRemove,
  removeLabel,
  className,
  ...props
}: {
  view: TileView
  onRemove?: () => void
  removeLabel?: string
} & ComponentProps<'div'>) {
  const { t } = useTranslation('composer')
  const picture = view.status !== 'failed' && view.thumb
  const adding = view.status === 'adding'
  const remove = (event: MouseEvent) => {
    event.stopPropagation()
    onRemove?.()
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            {...props}
            className={cn(
              'group/tile relative size-28 shrink-0 cursor-default rounded-2xl outline-none select-none focus-ring',
              className,
            )}
          />
        }
      >
        {picture ? (
          <img
            src={view.thumb!}
            alt=""
            draggable={false}
            className="size-full rounded-[inherit] object-cover"
          />
        ) : adding && view.kind === 'image' ? (
          // Shown only when reading takes a while, so a quick one never flashes.
          <div className="absolute inset-0 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
            <Skeleton className="size-full rounded-[inherit]" />
          </div>
        ) : (
          <div className="flex size-full flex-col justify-between p-2.5">
            {view.status === 'failed' ? (
              <CircleAlertIcon className="size-4 text-danger" />
            ) : adding ? (
              <Spinner className="size-4 animate-in text-icon fade-in fill-mode-both delay-200 duration-(--duration-fast)" />
            ) : view.kind === 'file' || view.kind === 'folder' ? (
              <FileTypeIcon path={view.name} folder={view.kind === 'folder'} className="size-4" />
            ) : (
              <span className="size-4" />
            )}
            <div className="min-w-0">
              <MiddleCutName name={view.name} />
              {adding ? (
                <div className="truncate text-meta text-tertiary animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
                  {t('attachments.reading')}
                </div>
              ) : (
                view.detail && (
                  <div
                    className={cn(
                      'truncate text-meta tabular',
                      view.status === 'failed' ? 'text-danger' : 'text-tertiary',
                    )}
                  >
                    {view.detail}
                  </div>
                )
              )}
            </div>
          </div>
        )}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-card transition-shadow duration-(--duration-fast) group-hover/tile:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
        />
        {view.warn && (
          <span className="absolute bottom-1 left-1 grid size-5 place-items-center rounded-full bg-surface text-primary shadow-card">
            <TriangleAlertIcon className="size-3" />
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={removeLabel}
            onClick={remove}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-surface text-icon opacity-0 shadow-card transition-opacity duration-(--duration-fast) group-focus-visible/tile:opacity-100 group-hover/tile:opacity-100 hover:text-primary"
          >
            <XIcon className="size-3" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">{view.tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** A name cut in the middle, so its end and extension stay: `ci-failure-…-1042.log`. */
function MiddleCutName({ name }: { name: string }) {
  const [head, tail] = cutName(name)
  return (
    <div className="flex min-w-0 text-xs leading-4 font-medium text-primary">
      <span className="truncate">{head}</span>
      <span className="max-w-[70%] shrink-0 truncate">{tail}</span>
    </div>
  )
}
