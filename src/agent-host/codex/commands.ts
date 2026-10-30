// Codex's slash commands, which run through app-server's own methods instead of going to the model
// as text, named as codex-acp named them, and the answers of the ones that start no turn.
// The answers' formats are adapted from codex-acp 2.2.2 (Apache-2.0, Copyright 2025 JetBrains
// s.r.o.): https://github.com/agentclientprotocol/codex-acp

import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { SlashCommand } from '@shared/thread'
import type { PromptBlock } from '../connection'
import { currentLocale, t } from '../i18n'
import type { SkillMetadata, ThreadTokenUsage } from './protocol'

const COMMANDS = [
  'plan',
  'mcp',
  'skills',
  'status',
  'review',
  'review-branch',
  'review-commit',
  'compact',
  'goal',
  'rename',
] as const

export type CodexCommand = (typeof COMMANDS)[number]

/** The commands that take text after their name. */
const WITH_INPUT = ['mcp', 'review', 'review-branch', 'review-commit', 'goal', 'rename'] as const

function hintOf(name: CodexCommand): string | null {
  const input = (WITH_INPUT as readonly string[]).includes(name)
    ? (name as (typeof WITH_INPUT)[number])
    : null
  return input ? t(`codex.command.${input}.hint`) : null
}

export interface ParsedCommand {
  name: CodexCommand
  rest: string
}

function isCommand(name: string): name is CodexCommand {
  return (COMMANDS as readonly string[]).includes(name)
}

/** The command a prompt's first text starts with; null for a prompt for the model. */
export function parseCommand(prompt: readonly PromptBlock[]): ParsedCommand | null {
  const first = prompt[0]
  if (!first || first.type !== 'text') return null
  const text = first.text.trim()
  if (!text.startsWith('/')) return null
  const body = text.slice(1).trim()
  const word = body.split(/\s+/)[0] ?? ''
  const name = word.toLowerCase()
  if (!isCommand(name)) return null
  return { name, rest: body.slice(word.length).trim() }
}

/** The commands a session offers: Codex's own, then a `$name` for each skill. */
export function commandList(skills: readonly SkillMetadata[]): SlashCommand[] {
  const commands = new Map<string, SlashCommand>()
  for (const name of COMMANDS) {
    const hint = hintOf(name)
    commands.set(name, {
      name,
      description: t(`codex.command.${name}.description`),
      ...(hint ? { inputHint: hint } : {}),
    })
  }
  for (const skill of skills) {
    const name = `$${skill.name}`
    if (commands.has(name)) continue
    commands.set(name, {
      name,
      description: skill.shortDescription ?? skill.description ?? skill.name,
    })
  }
  return [...commands.values()]
}

/** The answer to a command used without the text it needs. */
export function usageMessage(name: CodexCommand): string {
  return t('codex.command.usage', { name, hint: hintOf(name) ?? t('codex.command.noArguments') })
}

export function skillsMessage(skills: readonly SkillMetadata[]): string {
  if (skills.length === 0) return t('codex.command.noSkills')
  const lines = skills.map((skill) => {
    const description = skill.shortDescription ?? skill.description ?? ''
    return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`
  })
  return [t('codex.command.skillsTitle'), ...lines].join('\n')
}

export interface StatusFacts {
  model: string
  effort: string | null
  cwd: string
  approval: string
  sandbox: string
  account: AgentAccount | null
  sessionId: string
  usage: ThreadTokenUsage | null
  /** Null when they could not be read. */
  limits: readonly PlanLimit[] | null
  now: number
}

function tokenCount(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`
  return String(count)
}

function accountText(account: AgentAccount | null): string {
  if (!account || account.kind === 'none') return t('codex.status.notSignedIn')
  return account.email ? `${account.label} (${account.email})` : account.label
}

function tokensText(usage: ThreadTokenUsage | null): string {
  if (!usage) return t('codex.status.notAvailable')
  const { total } = usage
  // Codex counts the cached and cache-written input in its input; the answer counts them apart.
  const input = Math.max(
    0,
    total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens,
  )
  return t('codex.status.tokenCounts', {
    total: tokenCount(total.totalTokens),
    input: tokenCount(input),
    cached: tokenCount(total.cachedInputTokens),
    cacheWrite:
      total.cacheWriteInputTokens > 0
        ? t('codex.status.cacheWrite', { count: tokenCount(total.cacheWriteInputTokens) })
        : '',
    output: tokenCount(total.outputTokens),
  })
}

function contextText(usage: ThreadTokenUsage | null): string {
  const size = usage?.modelContextWindow
  if (!usage || !size) return t('codex.status.notAvailable')
  const used = usage.last.totalTokens
  return t('codex.status.contextUsed', {
    percent: Math.round((used / size) * 100),
    used: tokenCount(used),
    size: tokenCount(size),
  })
}

function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return ''
  const locale = currentLocale()
  const date = new Date(resetsAt)
  const time = date.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  if (date.toDateString() === new Date(now).toDateString()) {
    return t('codex.status.resetsToday', { time })
  }
  const day = date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  return t('codex.status.resetsOn', { time, date: day })
}

function limitLines(limits: readonly PlanLimit[] | null, now: number): string[] {
  const lines = (limits ?? []).flatMap((limit) =>
    limit.usedPercent === null
      ? []
      : [
          t('codex.status.limit', {
            label: limit.label,
            value: t('codex.status.left', {
              percent: Math.round(100 - limit.usedPercent),
              reset: resetText(limit.resetsAt, now),
            }),
          }),
        ],
  )
  return lines.length > 0
    ? lines
    : [t('codex.status.limits', { value: t('codex.status.notAvailable') })]
}

/** `/status`: the session's settings, its token use and the plan's limits. */
export function statusMessage(facts: StatusFacts): string {
  const model = facts.effort ? `${facts.model}[${facts.effort}]` : facts.model
  // Two trailing spaces end each line, as a Markdown line break.
  return [
    t('codex.status.model', { value: model }),
    t('codex.status.directory', { value: facts.cwd }),
    t('codex.status.approval', { value: facts.approval }),
    t('codex.status.sandbox', { value: facts.sandbox }),
    t('codex.status.account', { value: accountText(facts.account) }),
    t('codex.status.session', { value: facts.sessionId }),
    '',
    t('codex.status.tokens', { value: tokensText(facts.usage) }),
    t('codex.status.context', { value: contextText(facts.usage) }),
    ...limitLines(facts.limits, facts.now),
  ].join('  \n')
}
