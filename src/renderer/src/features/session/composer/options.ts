import type { KeyboardEvent } from 'react'
import type { ConfigOption } from '@shared/thread'
import type { SelectOption } from './levels'

export const isSelect = (o: ConfigOption | undefined): o is SelectOption =>
  !!o && o.type === 'select' && !!o.choices?.length

/** The cycling keys of the composer, kept with the controls they step through. */
export function onCycleKeys(
  event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
  cycle: (category: 'mode' | 'thought_level') => boolean,
): boolean {
  const mod = event.metaKey || event.ctrlKey
  if (event.key === 'Tab' && event.shiftKey && !mod && !event.altKey) return cycle('mode')
  return (
    event.code === 'KeyE' &&
    event.altKey &&
    !event.shiftKey &&
    !mod &&
    // A layout whose Option+E types a character, as the euro sign, keeps it.
    !(event.key.length === 1 && event.key.toLowerCase() !== 'e') &&
    cycle('thought_level')
  )
}
