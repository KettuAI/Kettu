// A permission request of Claude Code's as the options Kettu shows, and the answer as Claude
// Code takes it. The option ids are the ACP adapter's, so answers stored with a thread still read.

import type { PendingPermission } from '@shared/thread'
import { t } from '../i18n'
import { modeName } from './config'
import type { AskedQuestion } from './tools'
import type {
  PermissionMode,
  PermissionResult,
  PermissionRule,
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

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Commands "always allow" never covers, since one bad call cannot be undone or gains rights. */
const UNSAFE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'dd',
  'mkfs',
  'format',
  'del',
  'erase',
  'rd',
  'remove-item',
  'sudo',
  'su',
  'doas',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'killall',
  'pkill',
  'stop-process',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
])
const UNSAFE_GIT = new Set(['clean', 'reset'])

/** A rule's command as it reads: `pnpm dev:*` and `pnpm dev *` allow `pnpm dev` and what follows. */
function ruleCommand(content: string): string {
  return content.replace(/(?::\*|\s+\*)$/, '').trim()
}

/** The first word of each step of a command line, past variable assignments and `xargs`. */
function commandHeads(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((step) => {
      const words = step.trim().split(/\s+/).filter(Boolean)
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
      if (words[0] === 'xargs') {
        words.shift()
        while (words[0]?.startsWith('-')) words.shift()
      }
      return words.map((word) => word.toLowerCase().replace(/^.*[\\/]/, ''))
    })
    .filter((words) => words.length > 0)
}

/** Whether a rule would let a shell run anything, or a command that deletes or gains rights. */
export function unsafeRule(rule: PermissionRule): boolean {
  if (!SHELL_TOOLS.has(rule.toolName)) return false
  const command = ruleCommand(rule.ruleContent ?? '')
  if (command === '' || command === '*') return true
  return commandHeads(command).some(([head, sub]) => {
    if (head === undefined) return false
    if (UNSAFE_COMMANDS.has(head) || head.startsWith('mkfs.')) return true
    return head === 'git' && sub !== undefined && UNSAFE_GIT.has(sub)
  })
}

/**
 * The suggestions "always allow" may apply: a rule for a command that deletes or gains rights is
 * left out, so a request to run `rm -rf x && pnpm dev` offers to remember only `pnpm dev`.
 */
export function safeSuggestions(suggestions: readonly PermissionUpdate[]): PermissionUpdate[] {
  const safe: PermissionUpdate[] = []
  for (const update of suggestions) {
    if (update.type !== 'addRules' || update.behavior !== 'allow') {
      safe.push(update)
      continue
    }
    const rules = update.rules.filter((rule) => !unsafeRule(rule))
    if (rules.length > 0) safe.push({ ...update, rules })
  }
  return safe
}

/** A rule as the option shows it, in backticks: a command as typed, another tool as Claude Code writes it. */
function ruleText(rule: PermissionRule): string {
  if (SHELL_TOOLS.has(rule.toolName) && rule.ruleContent) {
    return `\`${ruleCommand(rule.ruleContent)}\``
  }
  return `\`${rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName}\``
}

function place(destination: RuleDestination): string {
  switch (destination) {
    case 'userSettings':
      return t('permission.place.user')
    case 'projectSettings':
    case 'localSettings':
      return t('permission.place.project')
    default:
      return t('permission.place.session')
  }
}

/**
 * What "always allow" would change, as the option says it: the rules it adds and where, or the
 * folders it opens. Null when the suggestions hold nothing an option can name truthfully.
 */
export function alwaysAllowName(suggestions: readonly PermissionUpdate[]): string | null {
  const only = suggestions.length === 1 ? suggestions[0] : undefined
  if (only?.type === 'setMode' && only.mode === 'acceptEdits' && only.destination === 'session') {
    return t('permission.acceptEdits')
  }
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
          directories: update.directories.map((directory) => `\`${directory}\``).join(', '),
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
    {
      id: OPTION.allowOnce,
      name: t(EDIT_TOOLS.has(toolName) ? 'permission.allowEdit' : 'permission.allowOnce'),
      kind: 'allow_once',
    },
  ]
  const suggestions = safeSuggestions(context.suggestions ?? [])
  const always =
    context.suppressAlwaysAllowRule === true || suggestions.length === 0
      ? null
      : alwaysAllowName(suggestions)
  if (always) options.push({ id: OPTION.allowAlways, name: always, kind: 'allow_always' })
  options.push({ id: OPTION.reject, name: t('permission.reject'), kind: 'reject_once' })
  return options
}

// A denial stops the turn's plan: the user says what to do instead in their next message.
export const REJECTED =
  'The user denied this tool use and will say what to do instead. Do not try another way; stop and wait for their next message.'
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
      updatedPermissions: safeSuggestions(context.suggestions ?? []),
      toolUseID,
    }
  }
  return { behavior: 'deny', message: REJECTED, toolUseID }
}

/** The option that lets the user answer a question in their own words, in their next message. */
export const OTHER_ANSWER = 'other'
export const ANSWER_IN_REPLY =
  'The user will answer this question in their own words. Stop here and wait for their next message.'
export const QUESTION_UNREADABLE =
  'This question could not be shown to the user. Ask it in your reply instead.'

/** A question's answers as options: each choice, then one to answer in the user's own words. */
export function questionOptions(question: AskedQuestion): Options {
  return [
    ...question.options.map((option, index) => ({
      id: `answer:${index}`,
      name: option.label,
      kind: 'allow_once' as const,
      ...(option.description ? { description: option.description } : {}),
    })),
    { id: OTHER_ANSWER, name: t('question.other'), kind: 'reject_once' as const },
  ]
}

/** The mode an answer moves the session to, for the mode option to show. */
export function answeredMode(optionId: string): PermissionMode | null {
  return EXIT_PLAN_MODES[optionId] ?? null
}
