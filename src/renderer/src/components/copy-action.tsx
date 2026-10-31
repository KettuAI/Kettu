import { useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'

/** An icon-only quiet button, named by its tooltip and its accessible name. */
export function IconAction({
  label,
  onClick,
  disabled,
  busy,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            aria-busy={busy}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Copies `text`; the icon turns into a check for a moment, which is the confirmation. */
export function CopyAction({ text, label }: { text: string | (() => string); label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconAction
      label={label}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? (
        <CheckIcon className="animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75" />
      ) : (
        <CopyIcon />
      )}
    </IconAction>
  )
}
