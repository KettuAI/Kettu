import { useRef, useState, type PointerEvent } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ArrowUp02Icon, Clock01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'
import { DESCRIBED_ROW, ItemText } from './menu-parts'

// Held this long, the Send button offers Send now beside Queue it.
const HOLD_MS = 450

/**
 * Send, as the Chat Composer draws it: a round 28 px button, in the primary button's tint once
 * there is something to send and quiet gray while there is not.
 */
export function SendButton({
  disabled,
  label,
  onClick,
  className,
}: {
  disabled: boolean
  label: string
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('ui-ccc__send kettu-send', className)}
    >
      <ArrowUpGlyph />
    </button>
  )
}

/** The Chat Composer's own arrow, so Send reads the same on every composer. */
function ArrowUpGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5.5V19"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Stop while a turn runs and the box is empty, in ink; Esc does the same. */
export function StopButton({ onStop }: { onStop: () => void }) {
  const { t } = useTranslation('composer')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t('prompt.stop')}
            data-stop=""
            onClick={onStop}
            className="ui-ccc__send kettu-send"
          />
        }
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" />
        </svg>
      </TooltipTrigger>
      <TooltipContent>
        <Trans
          t={t}
          i18nKey="prompt.stopTooltip"
          values={{ shortcut: 'Esc' }}
          components={{ shortcut: <span className="opacity-60" /> }}
        />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Send while a turn runs and the box holds a message: it queues the message. Where the agent takes
 * messages into a running turn, holding it offers Send now; the keys do the same without the menu.
 */
export function QueueButton({
  steering,
  queueKey,
  steerKey,
  onQueue,
  onSteer,
}: {
  steering: boolean
  queueKey: string
  steerKey: string
  onQueue: () => void
  onSteer: () => void
}) {
  const { t } = useTranslation('composer')
  const anchor = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  // The press that opened the menu, whose click must not queue the message.
  const held = useRef(false)
  const [open, setOpen] = useState(false)

  const release = () => window.clearTimeout(timer.current)
  const press = (event: PointerEvent) => {
    held.current = false
    if (!steering || event.button !== 0) return
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
            <button
              ref={anchor}
              type="button"
              aria-label={t('prompt.send')}
              onPointerDown={press}
              onPointerUp={release}
              onPointerLeave={release}
              onClick={() => {
                if (held.current) held.current = false
                else onQueue()
              }}
              className="ui-ccc__send kettu-send"
            />
          }
        >
          <ArrowUpGlyph />
        </TooltipTrigger>
        <TooltipContent>
          <Trans
            t={t}
            i18nKey={steering ? 'prompt.queueHoldTooltip' : 'prompt.queueTooltip'}
            values={{ shortcut: formatShortcut(queueKey) }}
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
          className="isolate z-(--layer-menu) outline-none"
        >
          <MenuPrimitive.Popup
            data-slot="dropdown-menu-content"
            data-overlay-layer=""
            className="z-50 w-78 origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground shadow-menu duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <DropdownMenuItem className={DESCRIBED_ROW} onClick={onQueue}>
              <Glyph icon={Clock01Icon} />
              <ItemText name={t('prompt.queueIt')} description={t('prompt.queueItHint')} />
              <DropdownMenuShortcut>{formatShortcut(queueKey)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className={DESCRIBED_ROW} onClick={onSteer}>
              <Glyph icon={ArrowUp02Icon} />
              <ItemText name={t('prompt.sendNow')} description={t('prompt.sendNowHint')} />
              <DropdownMenuShortcut>{formatShortcut(steerKey)}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  )
}
