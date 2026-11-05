// A permission request of Claude Code's as the options Kettu shows, and the answer as Claude
// Code takes it. The option ids are the ACP adapter's, so answers stored with a thread still read.

import type { PendingPermission, PendingQuestion, QuestionAnswer } from '@shared/thread'
import { unsafeCommand, unsafeCommandPrefix } from '../command-safety'
import { t } from '../i18n'
import { answerWords } from '../question-answers'
import { modeDescription, modeName } from './config'
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

/** The modes a plan's approval builds in, in the order its options offer them. */
export const BUILD_MODES: readonly PermissionMode[] = Object.values(EXIT_PLAN_MODES)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** `pnpm dev:*` and `pnpm dev *` allow `pnpm dev` and what follows it. */
const PREFIX_RULE = /(?::\*|\s+\*)$/

/** A rule's command as it reads, without the `*` that lets anything follow it. */
function ruleCommand(content: string): string {
  return content.replace(PREFIX_RULE, '').trim()
}

/**
 * Whether a rule would let a shell run anything, or a command that deletes, gains rights or
 * runs another that its text does not show.
 */
export function unsafeRule(rule: PermissionRule): boolean {
  if (!SHELL_TOOLS.has(rule.toolName)) return false
  const content = rule.ruleContent ?? ''
  const command = ruleCommand(content)
  // Claude Code reads a `*` anywhere in a rule as a wildcard.
  if (command === '' || command.includes('*')) return true
  const shell = rule.toolName === 'PowerShell' ? 'powershell' : 'posix'
  return PREFIX_RULE.test(content)
    ? unsafeCommandPrefix(command, shell)
    : unsafeCommand(command, shell)
}

/**
 * The suggestions "always allow" may apply: a rule for a command that deletes or gains rights is
 * left out, so a request to run `rm -rf x && pnpm dev` offers to remember only `pnpm dev`.
 */
export function safeSuggestions(suggestions: readonly PermissionUpdate[]): PermissionUpdate[] {
  const safe: PermissionUpdate[] = []
  for (const update of suggestions) {
    if (
      (update.type !== 'addRules' && update.type !== 'replaceRules') ||
      update.behavior !== 'allow'
    ) {
      safe.push(update)
      continue
    }
    const rules = update.rules.filter((rule) => !unsafeRule(rule))
    if (rules.length > 0) safe.push({ ...update, rules })
  }
  return safe
}

/** Text in backticks, which the option shows as code; null when a backtick in it would end that. */
function code(text: string): string | null {
  return text.includes('`') ? null : `\`${text}\``
}

/** A rule as the option shows it: a command as typed, another tool as Claude Code writes it. */
function ruleText(rule: PermissionRule): string | null {
  if (SHELL_TOOLS.has(rule.toolName) && rule.ruleContent) return code(ruleCommand(rule.ruleContent))
  return code(rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)
}

function place(destination: RuleDestination): string {
  switch (destination) {
    case 'userSettings':
      return t('permission.place.user')
    // The settings file committed with the project, which everyone working on it shares.
    case 'projectSettings':
      return t('permission.place.shared')
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
  const separator = t('permission.listSeparator')
  for (const update of suggestions) {
    if (update.type === 'addRules' && update.behavior === 'allow' && update.rules.length > 0) {
      const rules = update.rules.map(ruleText)
      if (!rules.every((rule) => rule !== null)) return null
      parts.push(
        t('permission.addRules', {
          rules: rules.join(separator),
          place: place(update.destination),
        }),
      )
    } else if (update.type === 'addDirectories' && update.directories.length > 0) {
      const directories = update.directories.map(code)
      if (!directories.every((directory) => directory !== null)) return null
      parts.push(
        t('permission.addDirectories', {
          directories: directories.join(separator),
          place: place(update.destination),
        }),
      )
    } else if (update.type === 'setMode') {
      parts.push(t('permission.setMode', { mode: modeName(update.mode) }))
    } else {
      return null
    }
  }
  return parts.length > 0
    ? t('permission.allowAlways', { changes: parts.join(t('permission.changeSeparator')) })
    : null
}

/**
 * A plan's approval: a mode to build in, named as the mode menu names it, with `preferred` the one
 * to start with chosen, or Keep planning with a note on what to change.
 */
export function planOptions(modes: readonly string[], preferred: PermissionMode): Options {
  const offered = Object.entries(EXIT_PLAN_MODES).filter(([, mode]) => modes.includes(mode))
  const chosen = offered.some(([, mode]) => mode === preferred) ? preferred : 'default'
  return [
    ...offered.map(([id, mode]) => {
      const description = modeDescription(mode)
      return {
        id,
        name: modeName(mode),
        // Kinds as the ACP adapter gave them, which stored answers keep.
        kind: mode === 'default' ? ('allow_once' as const) : ('allow_always' as const),
        ...(description ? { description } : {}),
        ...(mode === chosen ? { preferred: true } : {}),
      }
    }),
    {
      id: OPTION.reject,
      name: t('permission.exitPlan.keepPlanning'),
      kind: 'reject_once',
      note: true,
    },
  ]
}

/** The options of one request, in the order Claude Code offers them. */
export function permissionOptions(
  toolName: string,
  context: Pick<ToolPermissionContext, 'suggestions' | 'suppressAlwaysAllowRule'>,
  modes: readonly string[],
  buildMode: PermissionMode = 'default',
): Options {
  if (toolName === 'ExitPlanMode') return planOptions(modes, buildMode)
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

// Denied, ExitPlanMode leaves Claude Code in plan mode, where it revises the plan.
export const KEEP_PLANNING =
  'The user wants to keep planning and will say what to change in the plan. Stay in plan mode; stop and wait for their next message.'

export function keepPlanningWith(note: string): string {
  return `The user wants you to keep planning and revise the plan. Their note: ${note}`
}

/** The answer Claude Code gets for a plan's approval: the mode to build in, or keep planning. */
export function planResult(
  answer: { optionId: string; note?: string } | null,
  input: Record<string, unknown>,
  context: Pick<ToolPermissionContext, 'toolUseID'>,
): PermissionResult {
  const { toolUseID } = context
  if (answer === null) return { behavior: 'deny', message: CANCELLED, toolUseID }
  if (EXIT_PLAN_MODES[answer.optionId]) return permissionResult(answer.optionId, input, context)
  const message = answer.note ? keepPlanningWith(answer.note) : KEEP_PLANNING
  return { behavior: 'deny', message, toolUseID }
}

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
export const QUESTIONS_SKIPPED =
  'The user skipped these questions without answering. Go on with your own judgment, or ask again in your reply.'

/** An ask's questions as a card shows them; Claude Code always lets the user answer in their own words. */
export function pendingQuestions(questions: readonly AskedQuestion[]): PendingQuestion[] {
  return questions.map((asked) => ({
    header: asked.header,
    question: asked.question,
    multiSelect: asked.multiSelect,
    options: asked.options.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    allowsText: true,
    secret: false,
  }))
}

/** What Claude Code takes as `answers`, by question text; several words join with a comma. */
export function questionAnswers(
  questions: readonly AskedQuestion[],
  answers: readonly QuestionAnswer[],
): Record<string, string> {
  const pending = pendingQuestions(questions)
  const given: Record<string, string> = {}
  for (const answer of [...answers].sort((a, b) => a.question - b.question)) {
    const asked = pending[answer.question]
    if (asked) given[asked.question] = answerWords(asked, answer).join(', ')
  }
  return given
}

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
