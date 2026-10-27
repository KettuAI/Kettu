import { useState, type ComponentProps } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

/** `text` may be a function, for text too costly to build on every render. */
export function CopyButton({
  text,
  label,
  className,
  size = 'icon-xs',
}: {
  text: string | (() => string)
  label: string
  className?: string
  size?: ComponentProps<typeof Button>['size']
}) {
  const [copied, setCopied] = useState(false)
  // A message's row takes the button's own 16 px icon; every other Copy keeps 14 px.
  const iconSize = size === 'icon-message' ? undefined : 'size-3.5'
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
          <CheckIcon
            className={cn(
              iconSize,
              'animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75',
            )}
          />
        ) : (
          <CopyIcon className={iconSize} />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
