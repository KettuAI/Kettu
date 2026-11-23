// What a call of one of agy's own tools for sub-agents, messages, timers and background tasks is
// named in the thread: by what it does, in the interface language, with what it acts on. agy titles
// every call "Run <tool>" and gives its input as is (1.5.15); this is worked out when drawn, so
// earlier sessions read the same.

import type { ToolEntry } from '@shared/thread'
import { duration } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

/** The name of the session one of agy's conversation ids stands for, where the window has it. */
export type AgentSessionName = (agentSessionId: string) => string | null

type Args = Record<string, unknown>

const TITLE = /^Run (invoke_subagent|send_message|schedule|manage_task|manage_subagents)$/
const TASK_ACTIONS = new Set(['list', 'status', 'kill', 'send_input'])
const SUBAGENT_ACTIONS = new Set(['list', 'kill', 'kill_all'])
/** The type agy gives a sub-agent started as a copy of its parent, which names nothing. */
const SELF = 'self'

function argsOf(raw: string | undefined): Args | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Args)
      : null
  } catch {
    return null
  }
}

function words(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** A background task by the part of its id after the conversation's, such as `task-15`. */
function taskName(id: unknown): string | null {
  const name = words(id)
  return name && (name.split('/').pop() || name)
}

function named(id: unknown, names: AgentSessionName | undefined): string | null {
  const agentSessionId = words(id)
  return agentSessionId ? (names?.(agentSessionId) ?? null) : null
}

/**
 * The label of a call of one of these tools of agy's, null for any other call. What a call types
 * into a task, or the message it sends, is left out.
 */
export function agyLabel(
  entry: Pick<ToolEntry, 'title' | 'rawInput'>,
  names?: AgentSessionName,
): { verb: string; target: string | null; kind: 'tool' } | null {
  const tool = TITLE.exec(entry.title)?.[1]
  const args = argsOf(entry.rawInput)
  if (!tool || !args) return null
  const label = (verb: string, target: string | null = null) => ({
    verb,
    target,
    kind: 'tool' as const,
  })
  switch (tool) {
    case 'invoke_subagent': {
      const type = words(args.TypeName)
      return label(
        i18n.t('session:agyTool.invoke_subagent'),
        words(args.Role) ?? (type === SELF ? null : type),
      )
    }
    case 'send_message':
      return label(i18n.t('session:agyTool.send_message'), named(args.Recipient, names))
    case 'schedule': {
      const seconds = args.DurationSeconds
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        return label(i18n.t('session:agyTool.wait'), duration(seconds * 1000))
      }
      return label(i18n.t('session:agyTool.cron'), words(args.CronExpression))
    }
    case 'manage_task': {
      const action = words(args.Action)
      if (!action || !TASK_ACTIONS.has(action)) return null
      return label(
        i18n.t(`session:agyTool.manage_task.${action as 'list'}`),
        action === 'list' ? null : taskName(args.TaskId),
      )
    }
    case 'manage_subagents': {
      const action = words(args.Action)
      if (!action || !SUBAGENT_ACTIONS.has(action)) return null
      const ids = Array.isArray(args.ConversationIds) ? args.ConversationIds : []
      const shown = ids.map((id) => named(id, names)).filter((name) => name !== null)
      return label(
        i18n.t(`session:agyTool.manage_subagents.${action as 'list'}`),
        action === 'kill' && shown.length > 0
          ? shown.join(i18n.t('session:summary.nameSeparator'))
          : null,
      )
    }
  }
  return null
}
