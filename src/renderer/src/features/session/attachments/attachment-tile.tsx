import type { ComponentProps, MouseEvent } from 'react'
import { Alert02Icon, Cancel01Icon, File02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '@shared/thread'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { cn } from '@renderer/lib/utils'
import { cutName } from './cut-name'
import { Glyph } from '@renderer/features/session/composer/glyph'

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
 * An attachment: an image as its picture, up to 112 px tall and 224 px wide in the composer so a
 * wide shot stays whole (the thumbnail is 224 px on its longer side), and 92 by 64 in a sent
 * message. Anything else is a 40 px tile with its icon, name and size. One that cannot be sent
 * has a red edge and says why.
 */
export function AttachmentTile({
  view,
  picture = 'small',
  onRemove,
  removeLabel,
  className,
  ...props
}: {
  view: TileView
  /** An image's size: the composer's picture, or the thread's crop. */
  picture?: 'small' | 'large'
  onRemove?: () => void
  removeLabel?: string
} & ComponentProps<'div'>) {
  const { t } = useTranslation('composer')
  const failed = view.status === 'failed'
  const adding = view.status === 'adding'
  const image = view.kind === 'image' && !failed && (view.thumb || adding)
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
              'group/tile relative shrink-0 cursor-default rounded-2xl outline-none select-none focus-ring',
              image
                ? picture === 'large'
                  ? 'h-16 w-23 rounded-code'
                  : view.thumb
                    ? 'inline-flex'
                    : 'size-28'
                : 'flex h-10 max-w-60 items-center gap-2.25 bg-subtle pr-1.5 pl-2.5',
              className,
            )}
          />
        }
      >
        {image ? (
          view.thumb ? (
            <img
              src={view.thumb}
              alt=""
              draggable={false}
              className={
                picture === 'large'
                  ? 'size-full rounded-[inherit] object-cover'
                  : 'block max-h-28 max-w-[min(calc(var(--spacing)*56),100%)] rounded-[inherit]'
              }
            />
          ) : (
            // Shown only when reading takes a while, so a quick one never flashes.
            <div className="absolute inset-0 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
              <Skeleton className="size-full rounded-[inherit]" />
            </div>
          )
        ) : (
          <>
            <span className={cn('flex shrink-0', failed ? 'text-danger' : 'text-tertiary')}>
              {failed ? (
                <Glyph icon={Alert02Icon} className="size-4" />
              ) : adding ? (
                <Spinner className="size-4 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)" />
              ) : view.kind === 'text' ? (
                <Glyph icon={File02Icon} className="size-4" />
              ) : (
                <FileTypeIcon path={view.name} folder={view.kind === 'folder'} className="size-4" />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <MiddleCutName name={view.name} />
              {adding ? (
                <span className="truncate text-caption text-tertiary animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
                  {t('attachments.reading')}
                </span>
              ) : (
                view.detail && (
                  <span
                    className={cn(
                      'truncate text-caption tabular',
                      failed ? 'text-danger' : 'text-tertiary',
                    )}
                  >
                    {view.detail}
                  </span>
                )
              )}
            </span>
            {onRemove ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={removeLabel}
                onClick={remove}
                className="grid size-5 shrink-0 place-items-center rounded-sm text-tertiary hover:text-primary"
              >
                <Glyph icon={Cancel01Icon} className="size-3" />
              </button>
            ) : (
              <span className="w-1" />
            )}
          </>
        )}
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-[inherit] transition-shadow duration-(--duration-fast)',
            failed
              ? 'shadow-[inset_0_0_0_var(--hairline)_var(--danger-border)]'
              : 'shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] group-hover/tile:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]',
          )}
        />
        {view.warn && (
          <span className="absolute bottom-0.5 left-0.5 grid size-4 place-items-center rounded-full bg-surface text-primary shadow-card">
            <Glyph icon={Alert02Icon} className="size-2.5" />
          </span>
        )}
        {image && onRemove && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={removeLabel}
            onClick={remove}
            className="absolute -top-1.5 -right-1.5 grid size-4.5 place-items-center rounded-full bg-surface text-icon opacity-0 shadow-card transition-opacity duration-(--duration-fast) group-focus-visible/tile:opacity-100 group-hover/tile:opacity-100 hover:text-primary"
          >
            <Glyph icon={Cancel01Icon} className="size-2.5" />
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
    <span className="flex min-w-0 text-hint leading-4 text-primary">
      <span className="truncate">{head}</span>
      <span className="max-w-[70%] shrink-0 truncate">{tail}</span>
    </span>
  )
}
