// What a host says needs the user, as a notification shows it: which setting allows it, what it
// replaces, what a click opens, and its text held to what a notification shows. The desktop app's
// notifications and the web client's both follow it.

import type { HostToMain } from './host-control'
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
  'task-needs-you': 'permission',
  'task-ended': 'turnEnded',
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
 * what a click opens: its session, the Routines page for a pause, or a workflow task. Null for a
 * malformed one.
 */
export function attentionTarget(
  message: HostAttention,
): { key: string; command: AppCommand } | null {
  if (typeof message.kind !== 'string' || !Object.hasOwn(ATTENTION_SETTING, message.kind)) {
    return null
  }
  if (typeof message.title !== 'string' || typeof message.body !== 'string') return null
  if (message.kind === 'routine-paused') {
    return isId(message.agentId)
      ? { key: `routines:${message.agentId}`, command: { kind: 'open-routines' } }
      : null
  }
  if (message.kind === 'task-needs-you' || message.kind === 'task-ended') {
    return isId(message.taskId)
      ? { key: `task:${message.taskId}`, command: { kind: 'open-task', taskId: message.taskId } }
      : null
  }
  return 'sessionId' in message && isId(message.sessionId)
    ? { key: message.sessionId, command: { kind: 'open-session', sessionId: message.sessionId } }
    : null
}

type AttentionMessage = Extract<HostToMain, { type: 'host:attention' }>

/**
 * What devices are pushed for an attention message: a workflow task's goes as its step's session,
 * which is what they open, and not at all when no step has a session.
 */
export function pushedAttention(message: AttentionMessage): AttentionMessage | null {
  if (!('taskId' in message)) return message
  if (message.sessionId === undefined) return null
  return {
    type: 'host:attention',
    kind: message.kind === 'task-needs-you' ? 'permission' : 'turn-ended',
    sessionId: message.sessionId,
    title: message.title,
    body: message.body,
    ...(message.front ? { front: message.front } : {}),
  }
}

/** The title and body as a notification shows them. */
export function attentionText(message: HostAttention): { title: string; body: string } {
  return { title: clip(message.title, MAX_TITLE), body: clip(message.body, MAX_BODY) }
}
