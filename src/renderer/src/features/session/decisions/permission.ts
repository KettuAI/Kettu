import { useTranslation } from 'react-i18next'
import type { PermissionKind, PermissionOption, ToolEntry } from '@shared/thread'
import { basename, relativePath } from '@renderer/lib/format'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { plainName, respondToPermission, toolLabel } from '../entries/helpers'
import type { Ask, AskContext } from './ask'

export const ACTION_KEY = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'other',
  fetch: 'fetch',
  switch_mode: 'switchMode',
  other: 'other',
} as const satisfies Record<ToolEntry['toolKind'], string>

// The short word for an option whose kind the request offers once; its own name reads under it.
const SHORT_KEY: Partial<Record<PermissionKind, 'allowOnce' | 'allowAlways' | 'deny'>> = {
  allow_once: 'allowOnce',
  allow_always: 'allowAlways',
  reject_once: 'deny',
}

/** The files a request touches: its diffs' and its locations', the first with how many more. */
function filesOf(entry: ToolEntry, projectPath: string): string | null {
  const paths = [
    ...entry.content.flatMap((c) => (c.type === 'diff' ? [c.path] : [])),
    ...entry.locations.map((l) => l.path),
  ].filter((path, i, all) => all.indexOf(path) === i)
  if (paths.length === 0) return null
  const first = relativePath(paths[0]!, projectPath)
  return paths.length > 1 ? `${first} +${paths.length - 1}` : first
}

/**
 * A tool call's request for permission on the Decision Card: who wants to do what, the command or
 * files with the folder and the agent's reason, then the agent's own options in its order. The
 * last row denies and sends the user's words as their next message.
 */
export function permissionAsk(
  entry: ToolEntry,
  ctx: AskContext,
  /** The routine's scope a run is held to, by name, when the request falls outside it. */
  routineScope: string | null,
): Ask {
  const { t, sessionId, agentName, projectPath } = ctx
  const permission = entry.permission!
  const { requestId, options } = permission
  const label = toolLabel(entry, projectPath)
  const facts: { label: string; value: string }[] = []
  if (label.kind === 'command' && label.target) {
    facts.push({ label: t('decision.fact.command'), value: label.target.split('\n')[0]! })
  } else if (label.kind === 'path') {
    const files = filesOf(entry, projectPath)
    if (files) facts.push({ label: t('decision.fact.file'), value: files })
  } else if (label.target) {
    facts.push({ label: t('decision.fact.tool'), value: label.target })
  }
  if (entry.description) facts.push({ label: t('decision.fact.why'), value: entry.description })
  if (label.kind === 'command') {
    facts.push({ label: t('decision.fact.folder'), value: basename(projectPath) })
  }
  if (routineScope) {
    facts.push({
      label: t('decision.fact.routine'),
      value: t('permission.outsideScope', { level: routineScope }),
    })
  }
  const deny =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    null
  const respond = (option: PermissionOption, text?: string) =>
    void ctx.go(requestId, async () => {
      await respondToPermission(sessionId, requestId, option.id)
      if (text) await ctx.say(text)
    })
  return {
    key: requestId,
    group: requestId,
    decision: {
      task: agentName,
      question: t('decision.allow', {
        agent: agentName,
        action: t(`permission.card.action.${ACTION_KEY[entry.toolKind]}`),
      }),
      facts: facts.slice(0, 3),
      options: options.map((option) => {
        const name = plainName(option.name)
        const short = SHORT_KEY[option.kind]
        const alone = options.filter((o) => o.kind === option.kind).length === 1
        const title = short && alone ? t(`permission.card.${short}`) : name
        return {
          id: option.id,
          title,
          summary: name !== title ? name : option.description,
        }
      }),
      own: deny ? t('decision.tellInstead', { agent: agentName }) : false,
    },
    answer: (answer) => {
      if (typeof answer !== 'object') return
      const option = options.find((o) => o.id === answer.option)
      if (option) respond(option)
      else if (answer.text && deny) respond(deny, answer.text)
    },
  }
}

/** The name of the routine scope a session's run is held to, which a request outside it names. */
export function useRoutineScope(sessionId: string): string | null {
  const { t } = useTranslation('routines')
  const routine = useSessionsStore((s) => s.byId[sessionId]?.routine ?? null)
  const level = useRoutinesStore((s) =>
    routine ? (s.byId[routine.routineId]?.scope.level ?? null) : null,
  )
  return level ? t(`permission.level.${level}.name`) : null
}
