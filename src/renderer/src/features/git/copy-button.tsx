import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/** `text` may be a function, for text too costly to build on every render. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string | (() => string)
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="quiet"
      size="icon-xs"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={cn('shrink-0', className)}
    >
      {copied ? (
        <CheckIcon className="size-3.5 animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  )
}
