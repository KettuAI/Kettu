// What a device did on the host, as its page in Settings lists it: when it happened and what, and
// which session or project, but never content, commands or where it connected from.

/** How long an event is kept. */
export const ACTIVITY_DAYS = 30

/** The most events kept for one device; the oldest go first. */
export const MAX_ACTIVITY = 500

/** The longest session title an event keeps, in characters, as long as a rename may make one. */
export const ACTIVITY_TITLE_CHARS = 200

/** Who renamed a device: the owner, on the host, or the device itself. */
export type ActivityActor = 'owner' | 'device'

export type DeviceActivity =
  | { at: number; kind: 'paired' }
  | { at: number; kind: 'connected' }
  | { at: number; kind: 'renamed'; from: string; to: string; by: ActivityActor }
  /** `unseen`: 90 days without a connection; `reset`: remote access was reset. */
  | { at: number; kind: 'removed'; by: 'owner' | 'unseen' | 'reset' }
  /** `title`: the session's then, null while it had none. */
  | {
      at: number
      kind: 'session-created' | 'session-archived' | 'session-deleted'
      sessionId: string
      title: string | null
    }
  /** `terminal-closed`: the device killed it, or its terminal port ended with it open. */
  | { at: number; kind: 'terminal-opened' | 'terminal-closed'; projectPath: string }

type Without<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** An event before the host stamps its time. */
export type NewActivity = Without<DeviceActivity, 'at'>
