// A permission request of Claude Code's as the options Kettu shows, and the answer as Claude
// Code takes it. The option ids are the ACP adapter's, so answers stored with a thread still read.

import type { PendingPermission } from '@shared/thread'
import { t } from '../i18n'
import { modeName } from './config'
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  RuleDestination,
  ToolPermissionContext,
} from './sdk'

export const OPTION = {
  allowOnce: 'allow-once',
  allowAlways: 'allow-with-updates',
  reject: 'reject',
  exitPlanAuto: 'exit-plan-auto',
  exitPlanAcceptEdits: 'exit-plan-accept-edits',
  exitPlanDefault: 'exit-plan-default',
} as const

type Options = PendingPermission['options']

const EXIT_PLAN_MODES: Record<string, PermissionMode> = {
  [OPTION.exitPlanAuto]: 'auto',
  [OPTION.exitPlanAcceptEdits]: 'acceptEdits',
  [OPTION.exitPlanDefault]: 'default',
}

function ruleText(rule: { toolName: string; ruleContent?: string }): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

function place(destination: RuleDestination): string {
  switch (destination) {
    case 'userSettings':
      return t('permission.place.user')
    case 'projectSettings':
      return t('permission.place.project')
    case 'localSettings':
      return t('permission.place.local')
    default:
      return t('permission.place.session')
  }
}

/**
 * What "always allow" would change, as the option says it: the rules it adds and where, or the
 * folders it opens. Null when the suggestions hold nothing an option can name truthfully.
 */
export function alwaysAllowName(suggestions: readonly PermissionUpdate[]): string | null {
  const parts: string[] = []
  for (const update of suggestions) {
    if (update.type === 'addRules' && update.behavior === 'allow' && update.rules.length > 0) {
      parts.push(
        t('permission.addRules', {
          rules: update.rules.map(ruleText).join(', '),
          place: place(update.destination),
        }),
      )
    } else if (update.type === 'addDirectories' && update.directories.length > 0) {
      parts.push(
        t('permission.addDirectories', {
          directories: update.directories.join(', '),
          place: place(update.destination),
        }),
      )
    } else if (update.type === 'setMode') {
      parts.push(t('permission.setMode', { mode: modeName(update.mode) }))
    } else {
      return null
    }
  }
  return parts.length > 0 ? t('permission.allowAlways', { changes: parts.join('; ') }) : null
}

/** The options of one request, in the order Claude Code offers them. */
export function permissionOptions(
  toolName: string,
  context: Pick<ToolPermissionContext, 'suggestions' | 'suppressAlwaysAllowRule'>,
  modes: readonly string[],
): Options {
  if (toolName === 'ExitPlanMode') {
    const options: Options = []
    if (modes.includes('auto')) {
      options.push({
        id: OPTION.exitPlanAuto,
        name: t('permission.exitPlan.auto'),
        kind: 'allow_always',
      })
    }
    options.push(
      {
        id: OPTION.exitPlanAcceptEdits,
        name: t('permission.exitPlan.acceptEdits'),
        kind: 'allow_always',
      },
      { id: OPTION.exitPlanDefault, name: t('permission.exitPlan.manual'), kind: 'allow_once' },
      { id: OPTION.reject, name: t('permission.exitPlan.keepPlanning'), kind: 'reject_once' },
    )
    return options
  }
  const options: Options = [
    { id: OPTION.allowOnce, name: t('permission.allowOnce'), kind: 'allow_once' },
  ]
  const suggestions = context.suggestions ?? []
  const always =
    context.suppressAlwaysAllowRule === true || suggestions.length === 0
      ? null
      : alwaysAllowName(suggestions)
  if (always) options.push({ id: OPTION.allowAlways, name: always, kind: 'allow_always' })
  options.push({ id: OPTION.reject, name: t('permission.reject'), kind: 'reject_once' })
  return options
}

export const REJECTED = 'The user rejected this tool use.'
export const CANCELLED = 'The user cancelled this prompt.'

/** The answer Claude Code gets for the option the user chose, or for none. */
export function permissionResult(
  optionId: string | null,
  input: Record<string, unknown>,
  context: Pick<ToolPermissionContext, 'suggestions' | 'toolUseID'>,
): PermissionResult {
  const { toolUseID } = context
  if (optionId === null) return { behavior: 'deny', message: CANCELLED, toolUseID }
  const mode = EXIT_PLAN_MODES[optionId]
  if (mode) {
    return {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
      toolUseID,
    }
  }
  if (optionId === OPTION.allowOnce) return { behavior: 'allow', updatedInput: input, toolUseID }
  if (optionId === OPTION.allowAlways) {
    return {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: context.suggestions ?? [],
      toolUseID,
    }
  }
  return { behavior: 'deny', message: REJECTED, toolUseID }
}

/** The mode an answer moves the session to, for the mode option to show. */
export function answeredMode(optionId: string): PermissionMode | null {
  return EXIT_PLAN_MODES[optionId] ?? null
}
