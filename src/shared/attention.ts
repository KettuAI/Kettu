// What a host says needs the user, as a notification shows it: which setting allows it, what it
// replaces, what a click opens, and its text held to what a notification shows. The desktop app's
// notifications and the web client's both follow it.

import type { AppCommand } from './ipc'
import type { HostAttention } from './remote/host-admin'
import type { SettingsFile } from './settings'

/** The Settings > Notifications switch for each kind. */
export const ATTENTION_SETTING = {
  permission: 'permission',
  'turn-ended': 'turnEnded',
  error: 'error',
  'routine-ended': 'routines',
  'routine-paused': 'routines',
} as const satisfies Record<HostAttention['kind'], keyof SettingsFile['notifications']>

const MAX_TITLE = 120
const MAX_BODY = 400

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/**
 * What a well-formed attention message stands for, which a newer one of the same replaces, and
 * what a click opens: its session, or the Routines page for a pause. Null for a malformed one.
 */
export function attentionTarget(
  message: HostAttention,
): { key: string; command: AppCommand } | null {
  if (!(message.kind in ATTENTION_SETTING)) return null
  if (typeof message.title !== 'string' || typeof message.body !== 'string') return null
  if (message.kind === 'routine-paused') {
    return isId(message.agentId)
      ? { key: `routines:${message.agentId}`, command: { kind: 'open-routines' } }
      : null
  }
  return isId(message.sessionId)
    ? { key: message.sessionId, command: { kind: 'open-session', sessionId: message.sessionId } }
    : null
}

/** The title and body as a notification shows them. */
export function attentionText(message: HostAttention): { title: string; body: string } {
  return { title: clip(message.title, MAX_TITLE), body: clip(message.body, MAX_BODY) }
}
