// The requests `codex app-server` sends for the user to answer, as Kettu's permission requests:
// each option is a decision the request lists, under the option ids codex-acp used.

import type {
  PendingPermission,
  PendingQuestion,
  PermissionKind,
  QuestionAnswer,
  ToolContent,
} from '@shared/thread'
import { commandSteps, unsafeArgvPrefix, unsafeCommand } from '../command-safety'
import type { OptionAnswer, PermissionRequest } from '../connection'
import { t } from '../i18n'
import { answerWords } from '../question-answers'
import type { MapperContext, MapperOutput } from '../session-updates'
import { commandFacts, type ThreadMapper } from './mapper'
import type {
  AdditionalPermissions,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  McpServerElicitationRequestParams,
  PermissionsRequestApprovalParams,
  RequestId,
  ToolRequestUserInputParams,
} from './protocol'

type Option = PendingPermission['options'][number]

/** A request for the user and what each answer sends back. */
export interface Approval {
  request: PermissionRequest
  respond(answer: OptionAnswer): unknown
  /** What a reply to the request's questions sends back, for a request that carries them. */
  answerQuestions?(answers: QuestionAnswer[]): unknown
}

const KIND_ORDER: Record<PermissionKind, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
}

// Stopping to say what to do instead comes before denying and going on, as the cards put it.
const rank = (option: Option): number =>
  KIND_ORDER[option.kind] - (option.id === 'cancel' ? 0.5 : 0)

function ordered(options: Option[]): Option[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
    .map(({ option }) => option)
}

function output(): MapperOutput {
  return { patches: [], effects: [] }
}

function permissionsText(permissions: AdditionalPermissions | null | undefined): ToolContent[] {
  const lines: string[] = []
  if (permissions?.network?.enabled) lines.push(t('codex.approval.network'))
  for (const file of permissions?.fileSystem?.read ?? []) {
    lines.push(t('codex.approval.read', { path: file }))
  }
  for (const file of permissions?.fileSystem?.write ?? []) {
    lines.push(t('codex.approval.write', { path: file }))
  }
  return lines.length > 0
    ? [{ type: 'markdown', markdown: lines.map((l) => `- ${l}`).join('\n') }]
    : []
}

/**
 * Whether a command is one never to allow for the session: the script inside the shell Codex runs
 * it in, as it reports `/bin/zsh -lc '...'`, or the command itself. Unsafe when there is none.
 */
export function unsafeSessionCommand(command: string | null | undefined): boolean {
  if (!command) return true
  const steps = commandSteps(command)
  const [shell, flag, script, ...more] = steps?.length === 1 ? steps[0]! : []
  if (
    shell !== undefined &&
    /(?:^|\/)(?:bash|zsh|sh)$/.test(shell) &&
    (flag === '-c' || flag === '-lc') &&
    script !== undefined &&
    more.length === 0
  ) {
    return unsafeCommand(script)
  }
  return unsafeCommand(command)
}

/** An option for a decision; null for one to leave out, such as remembering an unsafe command. */
function commandOption(
  decision: CommandExecutionApprovalDecision,
  index: number,
  unsafe: boolean,
): { option: Option; decision: CommandExecutionApprovalDecision } | null {
  if (decision === 'accept') {
    return {
      option: { id: 'allow_once', name: t('codex.approval.allowOnce'), kind: 'allow_once' },
      decision,
    }
  }
  if (decision === 'acceptForSession') {
    if (unsafe) return null
    return {
      option: {
        id: 'allow_for_session',
        name: t('codex.approval.allowSession'),
        kind: 'allow_always',
      },
      decision,
    }
  }
  if (decision === 'decline') {
    return {
      option: { id: 'decline', name: t('codex.approval.decline'), kind: 'reject_once' },
      decision,
    }
  }
  if (decision === 'cancel') {
    return {
      option: { id: 'cancel', name: t('codex.approval.cancel'), kind: 'reject_once' },
      decision,
    }
  }
  if ('acceptWithExecpolicyAmendment' in decision) {
    const words = decision.acceptWithExecpolicyAmendment.execpolicy_amendment
    if (unsafeArgvPrefix(words)) return null
    return {
      option: {
        id: 'accept_execpolicy_amendment',
        name: t('codex.approval.allowPrefix', { command: words.join(' ') }),
        kind: 'allow_always',
      },
      decision,
    }
  }
  if ('applyNetworkPolicyAmendment' in decision) {
    const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment
    const allow = amendment.action === 'allow'
    return {
      option: {
        id: `apply_network_policy_amendment:${index}`,
        name: t(allow ? 'codex.approval.allowHost' : 'codex.approval.denyHost', {
          host: amendment.host,
        }),
        kind: allow ? 'allow_always' : 'reject_always',
      },
      decision,
    }
  }
  return null
}

/** The decisions to offer when the request lists none, as Codex's own clients do. */
function commandDecisions(
  params: CommandExecutionRequestApprovalParams,
): CommandExecutionApprovalDecision[] {
  if (params.availableDecisions && params.availableDecisions.length > 0)
    return params.availableDecisions
  if (params.additionalPermissions) return ['accept', 'cancel']
  const decisions: CommandExecutionApprovalDecision[] = ['accept', 'acceptForSession']
  if (params.proposedExecpolicyAmendment?.length) {
    decisions.push({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment },
    })
  }
  for (const amendment of params.proposedNetworkPolicyAmendments ?? []) {
    decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } })
  }
  return [...decisions, 'decline', 'cancel']
}

export function commandApproval(
  params: CommandExecutionRequestApprovalParams,
  mapper: ThreadMapper,
  ctx: MapperContext,
): Approval {
  const out = output()
  const network = params.networkApprovalContext
  const facts = params.command
    ? commandFacts(params.command, params.cwd ?? '', params.commandActions)
    : null
  const content = [
    ...(network
      ? [{ type: 'markdown' as const, markdown: t('codex.approval.networkHost', network) }]
      : []),
    ...permissionsText(params.additionalPermissions),
  ]
  const started = ctx.thread.byId[`t:${params.itemId}`]?.kind === 'tool'
  const entryId = mapper.tool(ctx, out, params.itemId, {
    ...(started
      ? {}
      : {
          title: network
            ? t('codex.approval.networkTitle', network)
            : (facts?.title ?? t('codex.tool.runCommand')),
          toolKind: facts?.toolKind ?? 'execute',
          status: 'pending',
          locations: facts?.locations ?? [],
          ...(facts?.rawInput !== undefined ? { rawInput: facts.rawInput } : {}),
        }),
    ...(content.length > 0 ? { content } : {}),
    ...(params.reason ? { description: params.reason } : {}),
  })
  const unsafe = unsafeSessionCommand(params.command)
  const choices = commandDecisions(params)
    .map((decision, index) => commandOption(decision, index, unsafe))
    .filter((choice) => choice !== null)
  const options = ordered(choices.map((choice) => choice.option))
  return {
    request: { toolCallId: params.itemId, toolEntryId: entryId, output: out, options },
    respond: (answer) => {
      const chosen =
        answer === 'cancelled'
          ? null
          : choices.find((choice) => choice.option.id === answer.optionId)
      return { decision: chosen?.decision ?? 'cancel' }
    },
  }
}

export function fileChangeApproval(
  params: FileChangeRequestApprovalParams,
  mapper: ThreadMapper,
  ctx: MapperContext,
): Approval {
  const out = output()
  const started = ctx.thread.byId[`t:${params.itemId}`]?.kind === 'tool'
  const entryId = mapper.tool(ctx, out, params.itemId, {
    ...(started ? {} : { title: t('codex.tool.editFiles'), toolKind: 'edit', status: 'pending' }),
    ...(params.reason ? { description: params.reason } : {}),
  })
  const options: Option[] = ordered([
    { id: 'allow_once', name: t('codex.approval.allowEdit'), kind: 'allow_once' },
    { id: 'allow_for_session', name: t('codex.approval.allowSession'), kind: 'allow_always' },
    { id: 'decline', name: t('codex.approval.decline'), kind: 'reject_once' },
    { id: 'cancel', name: t('codex.approval.cancel'), kind: 'reject_once' },
  ])
  const decisions: Record<string, string> = {
    allow_once: 'accept',
    allow_for_session: 'acceptForSession',
    decline: 'decline',
    cancel: 'cancel',
  }
  return {
    request: { toolCallId: params.itemId, toolEntryId: entryId, output: out, options },
    respond: (answer) => ({
      decision: answer === 'cancelled' ? 'cancel' : (decisions[answer.optionId] ?? 'cancel'),
    }),
  }
}

export function permissionsApproval(
  params: PermissionsRequestApprovalParams,
  mapper: ThreadMapper,
  ctx: MapperContext,
): Approval {
  const out = output()
  const entryId = mapper.tool(ctx, out, params.itemId, {
    title: t('codex.approval.permissionsTitle'),
    // Never an edit or a command, so a routine's scope never answers it.
    toolKind: 'other',
    status: 'pending',
    content: permissionsText(params.permissions),
    ...(params.reason ? { description: params.reason } : {}),
  })
  const options: Option[] = [
    { id: 'allow_permissions_turn', name: t('codex.approval.allowTurn'), kind: 'allow_once' },
    {
      id: 'allow_permissions_session',
      name: t('codex.approval.allowSession'),
      kind: 'allow_always',
    },
    { id: 'reject_permissions', name: t('codex.approval.decline'), kind: 'reject_once' },
  ]
  return {
    request: { toolCallId: params.itemId, toolEntryId: entryId, output: out, options },
    respond: (answer) => {
      const id = answer === 'cancelled' ? 'reject_permissions' : answer.optionId
      if (id === 'allow_permissions_turn') return { permissions: params.permissions, scope: 'turn' }
      if (id === 'allow_permissions_session') {
        return { permissions: params.permissions, scope: 'session' }
      }
      return { permissions: {}, scope: 'turn' }
    },
  }
}

/** What Something else answers, so Codex stops to read the user's own words. */
export const ANSWER_IN_REPLY =
  'The user will answer this question in their own words in their next message. Stop here and wait for it.'

/**
 * The questions of one ask as a question card, each with its choices and, where Codex lets the
 * user write an answer or offers no choices, a field for it. The options are the first question's
 * choices and Something else, for a client that sends only an option id. Null without a question.
 */
export function userInputApproval(
  params: ToolRequestUserInputParams,
  mapper: ThreadMapper,
  ctx: MapperContext,
): Approval | null {
  const asked = params.questions
  const first = asked[0]
  if (!first) return null
  const out = output()
  const entryId = mapper.tool(ctx, out, params.itemId, {
    title: first.header || first.question,
    toolKind: 'other',
    status: 'pending',
    question: first.question || first.header,
  })
  const questions: PendingQuestion[] = asked.map((question) => {
    const choices = question.options ?? []
    return {
      header: question.header,
      question: question.question,
      multiSelect: false,
      options: choices.map((choice) => ({
        label: choice.label,
        ...(choice.description ? { description: choice.description } : {}),
      })),
      allowsText: question.isOther || choices.length === 0,
      secret: question.isSecret,
    }
  })
  const choices = first.options ?? []
  const options: Option[] = [
    ...choices.map((choice, index) => ({
      id: `answer:${index}`,
      name: choice.label,
      kind: 'allow_once' as const,
      ...(choice.description ? { description: choice.description } : {}),
    })),
    { id: 'other', name: t('question.other'), kind: 'reject_once' },
  ]
  return {
    request: { toolCallId: params.itemId, toolEntryId: entryId, output: out, options, questions },
    respond: (answer) => {
      if (answer === 'cancelled') return { answers: {} }
      const id = answer.optionId
      const choice = id.startsWith('answer:') ? choices[Number(id.slice('answer:'.length))] : null
      const text = choice ? choice.label : id === 'other' ? ANSWER_IN_REPLY : null
      return text === null ? { answers: {} } : { answers: { [first.id]: { answers: [text] } } }
    },
    answerQuestions: (answers) => {
      const given: Record<string, { answers: string[] }> = {}
      for (const answer of answers) {
        const question = asked[answer.question]
        const pending = questions[answer.question]
        if (!question || !pending) continue
        const words = answerWords(pending, answer)
        if (words.length > 0) given[question.id] = { answers: words }
      }
      return { answers: given }
    },
  }
}

/** An MCP server asking to go on: a link to open or a message to confirm. Null for a form. */
export function elicitationApproval(
  params: McpServerElicitationRequestParams,
  requestId: RequestId,
  mapper: ThreadMapper,
  ctx: MapperContext,
): Approval | null {
  let message: string
  if (params.mode === 'url') message = `${params.message}\n\n${params.url}`
  else if (params.mode === 'openai/userVerification') message = params.description
  else if (isEmptySchema(params.requestedSchema)) message = params.message
  else return null
  const out = output()
  const toolCallId = `elicitation:${String(requestId)}`
  const entryId = mapper.tool(ctx, out, toolCallId, {
    title: t('codex.approval.elicitationTitle', { server: params.serverName }),
    toolKind: 'other',
    status: 'pending',
    content: message ? [{ type: 'markdown', markdown: message }] : [],
  })
  // An MCP cancel dismisses the request without stopping the turn, so it is not ranked as a stop.
  const options: Option[] = ordered([
    { id: 'allow_once', name: t('codex.approval.accept'), kind: 'allow_once' },
    { id: 'decline', name: t('codex.approval.decline'), kind: 'reject_once' },
    { id: 'dismiss', name: t('codex.approval.dismiss'), kind: 'reject_once' },
  ])
  return {
    request: { toolCallId, toolEntryId: entryId, output: out, options },
    respond: (answer) => {
      const id = answer === 'cancelled' ? 'dismiss' : answer.optionId
      const action = id === 'allow_once' ? 'accept' : id === 'decline' ? 'decline' : 'cancel'
      return { action, content: action === 'accept' ? {} : null, _meta: null }
    },
  }
}

function isEmptySchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return true
  const properties = (schema as { properties?: unknown }).properties
  return (
    typeof properties !== 'object' || properties === null || Object.keys(properties).length === 0
  )
}

/** What a request for a session Kettu does not have gets: never an approval. */
export function refusal(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null }
    default:
      return null
  }
}
