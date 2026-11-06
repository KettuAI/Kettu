import { cloneElement, type ReactElement, type ReactNode, type Ref } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'

interface NoticeCardProps {
  /** The card itself, which a popover beside it anchors to. */
  ref?: Ref<HTMLDivElement>
  /** The 14 px icon or agent mark. */
  icon: ReactNode
  /** The words and the version; they wrap, never inside a version. */
  text: ReactNode
  /** The words as one string, the card's name. */
  label: string
  /** What the notice is about, in the card's tooltip. */
  detail?: string | null
  /** Opens what the notice is about. */
  onOpen?: () => void
  /** Wraps the card's button, such as the trigger of a popover beside the card. */
  opener?: ReactElement<{ render?: ReactElement }>
  /** The card's one action, a small secondary button. */
  action?: ReactNode
  /** A line under the words, such as a download's progress. */
  below?: ReactNode
  onDismiss?: () => void
  /** Stops what the notice shows, in the dismiss button's place, which then always shows. */
  onCancel?: () => void
  /** The cancel button's name; "Cancel update" by default. */
  cancelLabel?: string
}

/** A notice in the sidebar footer other than an update: a raised card over the account row. */
export function NoticeCard({
  ref,
  icon,
  text,
  label,
  detail,
  onOpen,
  opener,
  action,
  below,
  onDismiss,
  onCancel,
  cancelLabel,
}: NoticeCardProps) {
  const { t } = useTranslation('updates')
  const close = onCancel ?? onDismiss
  const closeLabel = onCancel ? (cancelLabel ?? t('app.cancel')) : t('close')
  const opens = !!(onOpen || opener)
  const hit = (
    <button
      type="button"
      data-notice-hit=""
      aria-label={label}
      aria-description={detail ?? undefined}
      onClick={onOpen}
      className="absolute inset-0 rounded-xl outline-none focus-ring"
    />
  )
  return (
    <div
      data-notice=""
      className="group/notice relative motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:animation-duration-(--duration-slow) motion-safe:ease-out-quint"
    >
      <div
        ref={ref}
        className={cn(
          'relative flex min-h-11 items-center gap-2.5 rounded-xl bg-(--shell-card) py-2 pr-2 pl-2.5 shadow-(--shell-card-shadow) transition-shadow duration-(--duration-fast)',
          opens &&
            'has-[>[data-notice-hit]:hover]:shadow-(--shell-card-shadow-hover) has-data-popup-open:shadow-(--shell-card-shadow-hover)',
        )}
      >
        {/* Buttons cannot nest, so the card opens through a button laid under its content. */}
        {opens && (
          <Tooltip disabled={!detail}>
            <TooltipTrigger
              render={opener ? cloneElement(opener, { render: hit }) : hit}
              delay={500}
            />
            <TooltipContent side="top" align="start" className="max-w-64">
              {detail}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Beside a second line the icon keeps to the first. */}
        <span
          className={cn(
            'pointer-events-none relative grid size-4 shrink-0 place-items-center',
            below && 'self-start',
          )}
        >
          {icon}
        </span>
        <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-control font-medium text-pretty text-(--shell-ink)">{text}</span>
          {below}
        </span>
        {action && <span className="relative flex shrink-0 items-center">{action}</span>}
      </div>
      {close && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                aria-label={closeLabel}
                onClick={close}
                className={cn(
                  'absolute -top-1.5 -right-1.5 size-4.5 rounded-full text-(--shell-faint) hover:text-(--shell-ink) [&_svg:not([class*=size-])]:size-3',
                  !onCancel &&
                    'opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/notice:opacity-100 group-hover/notice:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                )}
              />
            }
          >
            <Glyph icon={Cancel01Icon} size={12} />
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
