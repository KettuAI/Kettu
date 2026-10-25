// One clip or sound plays at a time in the window.

interface Playable {
  paused: boolean
  pause(): void
}

/** Pauses every playing item but the one that started. */
export function pauseOthers<T extends Playable>(started: T, all: Iterable<T>): void {
  for (const item of all) if (item !== started && !item.paused) item.pause()
}

let listening = false

/**
 * Listens on the whole document for a player starting, the viewer's and any scrolled out of
 * view included. `play` does not bubble, so the listener captures it.
 */
export function playOneAtATime(): void {
  if (listening) return
  listening = true
  document.addEventListener(
    'play',
    (event) => {
      if (event.target instanceof HTMLMediaElement) {
        pauseOthers(event.target, document.querySelectorAll<HTMLMediaElement>('video, audio'))
      }
    },
    true,
  )
}
