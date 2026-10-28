import type { ReactNode } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { back, forward, HISTORY_SHORTCUTS } from '@renderer/app/history'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useViewStore } from '@renderer/stores/view'

/** Back and Forward through what the main area showed. */
export function BackForward({ className }: { className?: string }) {
  const { t } = useTranslation('shell')
  // Settings' own back is the step back while it shows, and it has no step forward.
  const canBack = useViewStore((s) => s.settings.open || s.history.back.length > 0)
  const canForward = useViewStore((s) => !s.settings.open && s.history.forward.length > 0)
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <HistoryButton
        label={t('topBar.back')}
        shortcut={HISTORY_SHORTCUTS.back}
        disabled={!canBack}
        onClick={back}
      >
        <ArrowLeftIcon />
      </HistoryButton>
      <HistoryButton
        label={t('topBar.forward')}
        shortcut={HISTORY_SHORTCUTS.forward}
        disabled={!canForward}
        onClick={forward}
      >
        <ArrowRightIcon />
      </HistoryButton>
    </div>
  )
}

function HistoryButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string
  shortcut: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="app-region-no-drag text-secondary"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} <span className="opacity-60">{formatShortcut(shortcut)}</span>
      </TooltipContent>
    </Tooltip>
  )
}
