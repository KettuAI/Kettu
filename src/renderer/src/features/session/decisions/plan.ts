import type { ToolEntry } from '@shared/thread'
import { respondToPermission } from '../entries/helpers'
import type { Ask, AskContext } from './ask'

/** The Claude Code options that build in a mode, by the mode each sets. */
export const BUILD_MODES: Record<string, string> = {
  'exit-plan-auto': 'auto',
  'exit-plan-accept-edits': 'acceptEdits',
  'exit-plan-default': 'default',
}

/**
 * A plan's approval on the Decision Card: Claude Code's modes to build in, its preferred one
 * recommended, or Codex's choice to implement, then Keep planning; the last row keeps planning
 * with the user's words as the note.
 */
export function planAsk(entry: ToolEntry, ctx: AskContext): Ask {
  const { t, sessionId, agentName } = ctx
  const { requestId, options } = entry.permission!
  const keepOption =
    options.find((o) => o.note) ??
    options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always') ??
    null
  const choices = options.filter((o) => o !== keepOption)
  const building = choices.some((o) => Object.hasOwn(BUILD_MODES, o.id))
  const version = entry.planVersion ?? 1
  const answer = (id: string, note?: string) =>
    void ctx.go(requestId, () => respondToPermission(sessionId, requestId, id, note))
  return {
    key: requestId,
    group: requestId,
    decision: {
      task: `${agentName} · ${version > 1 ? t('planCard.version', { version }) : t('planCard.label')}`,
      question: building ? t('decision.startBuilding') : t('planCard.implementAsk'),
      options: [
        ...choices.map((o) => ({
          id: o.id,
          title: o.name,
          summary: o.description,
          recommended: building && o.preferred === true,
        })),
        ...(keepOption ? [{ id: keepOption.id, title: t('planCard.keepPlanningButton') }] : []),
      ],
      own: keepOption?.note ? t('planCard.keepPlanning', { agent: agentName }) : false,
    },
    answer: (given) => {
      if (typeof given !== 'object') return
      if (given.option && options.some((o) => o.id === given.option)) answer(given.option)
      else if (given.text && keepOption?.note) answer(keepOption.id, given.text)
    },
  }
}
