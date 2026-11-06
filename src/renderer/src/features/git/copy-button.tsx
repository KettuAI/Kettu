import { useState, type ComponentProps } from 'react'
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/session/composer/glyph'

/** `text` may be a function, for text too costly to build on every render. */
export function CopyButton({
  text,
  label,
  className,
  iconClassName,
  size = 'icon-xs',
}: {
  text: string | (() => string)
  label: string
  className?: string
  iconClassName?: string
  size?: ComponentProps<typeof Button>['size']
}) {
  const [copied, setCopied] = useState(false)
  // A message's row takes the button's own 16 px icon; every other Copy keeps 14 px.
  const iconSize = iconClassName ?? (size === 'icon-message' ? undefined : 'size-3.5')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size={size}
            aria-label={label}
            onClick={() => {
              void navigator.clipboard
                .writeText(typeof text === 'function' ? text() : text)
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
            }}
            className={cn('shrink-0', className)}
          />
        }
      >
        {copied ? (
          <Glyph
            icon={Tick02Icon}
            className={cn(
              iconSize,
              'animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75',
            )}
          />
        ) : (
          <Glyph icon={Copy01Icon} className={iconSize} />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
