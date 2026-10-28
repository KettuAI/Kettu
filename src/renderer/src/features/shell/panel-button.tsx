import type { ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'

/** An icon button in a side pane's header, which is a window drag region. */
export function PanelButton({
  label,
  shortcut,
  pressed,
  disabled,
  size = 'icon-xs',
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  pressed?: boolean
  disabled?: boolean
  size?: 'icon-xs' | 'icon-sm'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size={size}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className="app-region-no-drag"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
