import { useRef, useState, type PointerEvent } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ArrowUpIcon, HistoryIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut } from '@renderer/lib/platform'
import { DESCRIBED_ROW, ItemText } from './menu-parts'

// Held this long, the Stop button offers to queue or send the message instead.
const HOLD_MS = 450

const ROUND = 'size-8 rounded-full p-0 [&_svg:not([class*=size-])]:size-4'

/** Send: quiet while there is nothing to send, ink once there is. */
export function SendButton({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean
  label: string
  onClick?: () => void
}) {
  return (
    <Button
      variant="default"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`${ROUND} animate-in zoom-in-75 fade-in animation-duration-(--duration-fast) disabled:bg-subtle disabled:bg-none disabled:text-tertiary disabled:opacity-100 disabled:shadow-none`}
    >
      <ArrowUpIcon strokeWidth={1.75} />
    </Button>
  )
}

/**
 * Stop while a turn runs. With a message in the box, holding it offers Queue it and, where the
 * agent takes messages into a running turn, Send now; the keys do the same without the menu.
 */
export function RunningButton({
  holds,
  steering,
  queueKey,
  steerKey,
  onStop,
  onQueue,
  onSteer,
}: {
  /** The box holds a message that can be queued. */
  holds: boolean
  steering: boolean
  queueKey: string
  steerKey: string
  onStop: () => void
  onQueue: () => void
  onSteer: () => void
}) {
  const { t } = useTranslation('composer')
  const anchor = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  // The press that opened the menu, whose click must not stop the turn.
  const held = useRef(false)
  const [open, setOpen] = useState(false)

  const release = () => window.clearTimeout(timer.current)
  const press = (event: PointerEvent) => {
    held.current = false
    if (!holds || event.button !== 0) return
    timer.current = window.setTimeout(() => {
      held.current = true
      setOpen(true)
    }, HOLD_MS)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={anchor}
              variant="default"
              aria-label={t('prompt.stop')}
              onPointerDown={press}
              onPointerUp={release}
              onPointerLeave={release}
              onClick={() => {
                if (held.current) held.current = false
                else onStop()
              }}
              className={`${ROUND} animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)`}
            />
          }
        >
          <span aria-hidden className="size-2.5 rounded-[2.5px] bg-current" />
        </TooltipTrigger>
        <TooltipContent>
          <Trans
            t={t}
            i18nKey={holds ? 'prompt.stopHoldTooltip' : 'prompt.stopTooltip'}
            values={{ shortcut: 'Esc' }}
            components={{ shortcut: <span className="opacity-60" /> }}
          />
        </TooltipContent>
      </Tooltip>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="top"
          align="end"
          sideOffset={8}
          className="isolate z-50 outline-none"
        >
          <MenuPrimitive.Popup
            data-slot="dropdown-menu-content"
            data-overlay-layer=""
            className="z-50 w-78 origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground shadow-menu duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <DropdownMenuItem className={DESCRIBED_ROW} onClick={onQueue}>
              <HistoryIcon />
              <ItemText name={t('prompt.queueIt')} description={t('prompt.queueItHint')} />
              <DropdownMenuShortcut>{formatShortcut(queueKey)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            {steering && (
              <DropdownMenuItem className={DESCRIBED_ROW} onClick={onSteer}>
                <ArrowUpIcon />
                <ItemText name={t('prompt.sendNow')} description={t('prompt.sendNowHint')} />
                <DropdownMenuShortcut>{formatShortcut(steerKey)}</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  )
}
