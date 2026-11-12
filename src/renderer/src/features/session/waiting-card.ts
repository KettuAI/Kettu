import { useThreadsStore } from '@renderer/stores/threads'

/** The first card in the thread that waits for the user's answer. */
export function firstWaiting(sessionId: string): string | null {
  const state = useThreadsStore.getState().replicas[sessionId]?.state
  if (!state) return null
  for (const id of state.order) {
    const entry = state.byId[id]
    const waiting =
      (entry?.kind === 'tool' && !!entry.permission) ||
      (entry?.kind === 'browser_origin' && entry.decision === null) ||
      (entry?.kind === 'device_access' && entry.decision === null) ||
      (entry?.kind === 'computer_app' && entry.decision === null) ||
      (entry?.kind === 'computer_setup' && entry.outcome === null)
    if (waiting) return id
  }
  return null
}

/** Esc, Enter, Mod+Enter, or a number key 1 to 9. */
export type CardKey = 'escape' | 'enter' | 'confirm' | number

/**
 * Answers the first waiting card with a key, through the card's own control so a failure shows
 * where the answer was given: Esc denies, Enter allows a request or takes the highlighted option,
 * Mod+Enter confirms any card, and a number picks that row. False when no card shows the key.
 */
export function pressWaitingCard(sessionId: string, key: CardKey): boolean {
  const id = firstWaiting(sessionId)
  if (!id) return false
  const scope = `[data-entry-id="${CSS.escape(id)}"]`
  const target = document.querySelector<HTMLElement>(
    key === 'escape'
      ? `${scope} :is(.ui-apc__deny, .ui-prc__btn--deny)`
      : key === 'confirm'
        ? `${scope} :is(.ui-prc__btn--primary, .ui-xcc__action, .ui-apc__approve, [data-answer-enter])`
        : key === 'enter'
          ? `${scope} :is(.ui-prc__btn--primary, [data-answer-enter], [data-answer-option][data-highlighted])`
          : `${scope} :is([data-answer-option="${key}"], .ui-xcc__rows > .ui-xcc__row:nth-child(${key}))`,
  )
  if (!target) return false
  // A card busy with an answer takes the key and does nothing more.
  if (
    (target instanceof HTMLButtonElement && target.disabled) ||
    target.getAttribute('aria-disabled') === 'true'
  ) {
    return true
  }
  // The row of the user's own answer is a field to type in.
  const field =
    target instanceof HTMLInputElement ? target : target.querySelector<HTMLInputElement>('input')
  if (field) field.focus()
  else target.click()
  return true
}
