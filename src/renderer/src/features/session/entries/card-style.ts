// The look and keys a waiting card's parts share.

import type { KeyboardEvent } from 'react'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'

/** An option tile: a hairline edge, and once chosen or highlighted, the fox edge on its tint. */
export function tileClass(on: boolean): string {
  return cn(
    'flex w-full min-w-0 cursor-default items-center gap-3 rounded-card bg-card text-left text-foreground outline-none transition-[background-color,box-shadow] duration-(--duration-fast) focus-ring disabled:opacity-60',
    on ? 'bg-control-on-tint shadow-tile-on' : 'shadow-tile hover:enabled:bg-hover',
  )
}

/** Whether a key press is the card's confirm: Cmd+Return, or Ctrl+Return off macOS. */
export function isConfirmKey(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
