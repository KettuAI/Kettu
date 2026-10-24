// In-app events between parts of the interface that do not share a store.

export type AppEvent =
  | { kind: 'focus-composer' }
  | { kind: 'ask-selection' } // Mod+L with text selected in the terminal
  | { kind: 'new-terminal' }
  | { kind: 'insert-into-composer'; sessionId: string | null; text: string }
  | { kind: 'add-attachments' } // Mod+U: the composer's Add files or photos…
  | { kind: 'drop-attachments'; draft: string; files: File[] } // a session's id, or New session's draft
  | { kind: 'run-in-terminal'; projectPath: string; command: string }
  | { kind: 'sign-in-terminal'; projectPath: string; command: string; agentId: string }
  | { kind: 'sign-in-finished'; agentId: string } // the sign-in command's terminal exited

const listeners = new Set<(event: AppEvent) => void>()

export function emitAppEvent(event: AppEvent): void {
  for (const listener of listeners) listener(event)
}

export function onAppEvent(listener: (event: AppEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
