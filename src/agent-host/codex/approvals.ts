// The requests `codex app-server` sends for the user to answer, as Kettu's permission requests:
// each option is a decision the request lists, under the option ids codex-acp used.

import type { PendingPermission, PermissionKind, ToolContent } from '@shared/thread'
import type { PermissionAnswer, PermissionRequest } from '../connection'
import { t } from '../i18n'
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
  respond(answer: PermissionAnswer): unknown
}

const KIND_ORDER: Record<PermissionKind, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
}

function ordered(options: Option[]): Option[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => KIND_ORDER[a.option.kind] - KIND_ORDER[b.option.kind] || a.index - b.index)
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

function commandOption(
  decision: CommandExecutionApprovalDecision,
  index: number,
): { option: Option; decision: CommandExecutionApprovalDecision } | null {
  if (decision === 'accept') {
    return {
      option: { id: 'allow_once', name: t('codex.approval.allowOnce'), kind: 'allow_once' },
      decision,
    }
  }
  if (decision === 'acceptForSession') {
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
  const choices = commandDecisions(params)
    .map((decision, index) => commandOption(decision, index))
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
  const options: Option[] = [
    { id: 'allow_once', name: t('codex.approval.allowOnce'), kind: 'allow_once' },
    { id: 'allow_for_session', name: t('codex.approval.allowSession'), kind: 'allow_always' },
    { id: 'decline', name: t('codex.approval.decline'), kind: 'reject_once' },
    { id: 'cancel', name: t('codex.approval.cancel'), kind: 'reject_once' },
  ]
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

/**
 * A question with choices, as a request whose options are the choices. Null for anything else,
 * which Kettu cannot ask: several questions, free text or a secret.
 */
export function userInputApproval(
  params: ToolRequestUserInputParams,
  mapper: ThreadMapper,
  ctx: MapperContext,
): Approval | null {
  const question = params.questions.length === 1 ? params.questions[0]! : null
  const choices = question?.options ?? []
  if (!question || question.isSecret || choices.length === 0) return null
  const out = output()
  const entryId = mapper.tool(ctx, out, params.itemId, {
    title: question.header || question.question,
    toolKind: 'other',
    status: 'pending',
    ...(question.header && question.question ? { description: question.question } : {}),
  })
  const options: Option[] = choices.map((choice, index) => ({
    id: `answer:${index}`,
    name: choice.label,
    kind: 'allow_once',
  }))
  return {
    request: { toolCallId: params.itemId, toolEntryId: entryId, output: out, options },
    respond: (answer) => {
      const index = answer === 'cancelled' ? -1 : Number(answer.optionId.replace(/^answer:/, ''))
      const choice = choices[index]
      return choice ? { answers: { [question.id]: { answers: [choice.label] } } } : { answers: {} }
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
  const options: Option[] = [
    { id: 'allow_once', name: t('codex.approval.accept'), kind: 'allow_once' },
    { id: 'decline', name: t('codex.approval.decline'), kind: 'reject_once' },
    { id: 'cancel', name: t('codex.approval.cancel'), kind: 'reject_once' },
  ]
  return {
    request: { toolCallId, toolEntryId: entryId, output: out, options },
    respond: (answer) => {
      const id = answer === 'cancelled' ? 'cancel' : answer.optionId
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
