import type { ComponentProps, MouseEvent } from 'react'
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

/** What a tile shows, the same in the composer and in the thread. */
export interface TileView {
  name: string
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
  const picture = view.status !== 'failed' && view.thumb
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
        ) : view.status === 'adding' ? (
          // Shown only when reading takes a while, so a quick one never flashes.
          <div className="absolute inset-0 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
            <Skeleton className="size-full rounded-[inherit]" />
          </div>
        ) : (
          <div className="flex size-full flex-col justify-between p-2.5">
            {view.status === 'failed' ? (
              <CircleAlertIcon className="size-4 text-danger" />
            ) : (
              <span className="size-4" />
            )}
            <div className="min-w-0">
              <MiddleCutName name={view.name} />
              {view.detail && (
                <div
                  className={cn(
                    'truncate text-meta tabular',
                    view.status === 'failed' ? 'text-danger' : 'text-tertiary',
                  )}
                >
                  {view.detail}
                </div>
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

/** A name cut in the middle, so its extension stays: `ci-failure-…-1042.log`. */
function MiddleCutName({ name }: { name: string }) {
  const dot = name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return (
    <div className="flex min-w-0 text-xs leading-4 font-medium text-primary">
      <span className="truncate">{stem}</span>
      <span className="shrink-0">{extension}</span>
    </div>
  )
}
