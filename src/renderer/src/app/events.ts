// In-app events between parts of the interface that do not share a store.

export type AppEvent =
  | { kind: 'focus-composer' }
  | { kind: 'focus-browser-address'; sessionId: string } // Mod+L typed in a session's browser page
  | { kind: 'ask-selection' } // Mod+L with text selected in the terminal
  | { kind: 'new-terminal' }
  | { kind: 'close-side-tab' } // Mod+W with the side panel used last
  | { kind: 'new-browser-tab' } // Mod+T with the browser used last
  | { kind: 'insert-into-composer'; sessionId: string | null; text: string }
  // A mention, such as a terminal's, put after the text of the composer of `draft`.
  | { kind: 'mention-into-composer'; draft: string; mention: string }
  | { kind: 'command-into-composer'; sessionId: string; name: string } // a sent command, clicked
  // Sends what the session's composer holds, comments included, in the pane `paneId` or any.
  | { kind: 'send-composer'; sessionId: string; paneId: string | null }
  // Scrolls the thread to the passage a comment in the composer is on.
  | { kind: 'reveal-comment'; sessionId: string; paneId: string | null; commentId: string }
  // Written from outside its composer, which reloads it, and with `focus` takes the focus.
  | { kind: 'draft-written'; draft: string; focus?: true }
  | { kind: 'add-attachments' } // Mod+U: the composer's Add files or photos…
  | { kind: 'open-add-menu' } // Mod+Shift+A: the composer's plus menu
  | { kind: 'find-in-session' } // Mod+F: the find bar of the session in focus
  | { kind: 'drop-attachments'; draft: string; files: File[] } // a session's id, or New session's draft
  // To the side panel `panel` names, a session's or New session's, once it shows.
  | { kind: 'run-in-terminal'; panel: string; command: string }
  // A new terminal starting in `folder`, relative to the side panel's project.
  | { kind: 'open-terminal'; panel: string; folder: string }
  | { kind: 'sign-in-terminal'; panel: string; command: string; agentId: string }
  // The sign-in command's terminal exited, on the host `hostId` (null for this computer).
  | { kind: 'sign-in-finished'; agentId: string; hostId: string | null }

const listeners = new Set<(event: AppEvent) => void>()

export function emitAppEvent(event: AppEvent): void {
  for (const listener of listeners) listener(event)
}

export function onAppEvent(listener: (event: AppEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
