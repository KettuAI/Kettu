// What a host says needs the user, as a notification shows it: which setting allows it, what it
// replaces, what a click opens, and its text held to what a notification shows. The desktop app's
// notifications and the web client's both follow it.

import type { HostToMain } from './host-control'
import type { AppCommand } from './ipc'
import type { PlanLimitNoticeLevel } from './plan-limits'
import type { HostAttention } from './remote/host-admin'
import type { SettingsFile } from './settings'

/** The Settings > Notifications switch for each kind. */
export const ATTENTION_SETTING = {
  permission: 'permission',
  'turn-ended': 'turnEnded',
  error: 'error',
  'routine-ended': 'routines',
  'routine-paused': 'routines',
  'plan-limit': 'planLimits',
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

const PLAN_LIMIT_LEVELS: readonly PlanLimitNoticeLevel[] = ['near', 'reached', 'reset']

/**
 * What a well-formed attention message stands for, which a newer one of the same replaces, and
 * what a click opens: its session, the Routines page for a pause, a workflow task, or the Usage
 * page for a plan limit that names no session. Null for a malformed one.
 */
export function attentionTarget(
  message: HostAttention,
): { key: string; command: AppCommand } | null {
  if (typeof message.kind !== 'string' || !Object.hasOwn(ATTENTION_SETTING, message.kind)) {
    return null
  }
  if (typeof message.title !== 'string' || typeof message.body !== 'string') return null
  if (message.kind === 'plan-limit') {
    if (!isId(message.agentId) || !isId(message.key)) return null
    if (!PLAN_LIMIT_LEVELS.includes(message.level)) return null
    if (message.sessionId !== undefined) {
      return isId(message.sessionId)
        ? {
            key: message.sessionId,
            command: { kind: 'open-session', sessionId: message.sessionId },
          }
        : null
    }
    return { key: `limit:${message.key}`, command: { kind: 'open-usage' } }
  }
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
 * which is what they open, and not at all when no step has a session. A plan limit is not pushed:
 * it is the desktop's notice of the account, which devices do not take.
 */
export function pushedAttention(message: AttentionMessage): AttentionMessage | null {
  if (message.kind === 'plan-limit') return null
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

/** A session's turn that ended, failed or waits for the user, as a window in front shows it. */
export interface AttentionNotice {
  sessionId: string
  kind: 'permission' | 'turn-ended' | 'error' | 'routine-ended'
  title: string
  body: string
}

/**
 * What a window in front shows of a well-formed attention message in place of a notification,
 * titled `title` when another host's names it; null for what is not a session's turn.
 */
export function attentionNotice(
  message: HostAttention,
  title: string = message.title,
): AttentionNotice | null {
  if (!attentionTarget(message)) return null
  switch (message.kind) {
    case 'permission':
    case 'turn-ended':
    case 'error':
    case 'routine-ended':
      return isId(message.sessionId)
        ? {
            sessionId: message.sessionId,
            kind: message.kind,
            ...attentionText({ ...message, title }),
          }
        : null
    default:
      return null
  }
}

/** The title and body as a notification shows them. */
export function attentionText(message: HostAttention): { title: string; body: string } {
  return { title: clip(message.title, MAX_TITLE), body: clip(message.body, MAX_BODY) }
}
