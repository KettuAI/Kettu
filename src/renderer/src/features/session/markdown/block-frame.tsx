import { useState, type ComponentProps, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { cn } from '@renderer/lib/utils'

/**
 * The frame every block in a reply shares: code, diffs, shell output, SVG and diagrams. A 34 px
 * header holds the block's name on the left and its actions on the right.
 */
export function BlockFrame({
  header,
  children,
  className,
  ...props
}: ComponentProps<'div'> & { header: ReactNode }) {
  return (
    <div data-block-frame="" className={cn('block-frame', className)} {...props}>
      <div className="block-frame-header">{header}</div>
      {children}
    </div>
  )
}

/** Pushes what follows it to the header's right end. */
export function BlockSpacer() {
  return <span aria-hidden className="flex-1" />
}

/** A 26 px icon button in a block's header, named by its tooltip. */
export function BlockAction({
  label,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            aria-label={label}
            className={cn('block-frame-action', className)}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Copies `text` (or what the function returns, at the click) and shows a check for a moment. */
export function BlockCopy({ text, label }: { text: string | (() => string); label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <BlockAction
      label={label}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? (
        <CheckIcon
          strokeWidth={2}
          className="animate-in animation-duration-(--duration-fast) fade-in zoom-in-75"
        />
      ) : (
        <CopyIcon />
      )}
    </BlockAction>
  )
}

/** Preview and Source for a block drawn from its code: an SVG or a diagram. */
export function PreviewSourceSwitch({
  source,
  onChange,
  labels,
}: {
  source: boolean
  onChange: (source: boolean) => void
  labels: { preview: string; source: string; group: string }
}) {
  return (
    <SegmentedControl
      aria-label={labels.group}
      value={source ? 'source' : 'preview'}
      onChange={(next) => onChange(next === 'source')}
      segments={[
        { value: 'preview', label: labels.preview },
        { value: 'source', label: labels.source },
      ]}
      className="shadow-none"
      itemClassName="h-5.5 px-2 text-xs font-medium"
    />
  )
}
