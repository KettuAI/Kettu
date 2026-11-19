// Pi's slash commands as a session offers them. Pi's RPC lists the commands of its extensions, its
// prompt templates and its skills, which run when a prompt starts with their name. The commands of
// its terminal UI are not among them and do nothing over RPC, so the ones with an RPC command of
// their own run here, under the names the pi-acp adapter gave them.

import type { SlashCommand } from '@shared/thread'
import { t } from '../i18n'
import type { PiCommandInfo, PiStats } from './protocol'

const OWN = [
  'compact',
  'autocompact',
  'export',
  'session',
  'name',
  'steering',
  'follow-up',
  'changelog',
] as const

export type OwnCommand = (typeof OWN)[number]

/** The commands that take text after their name. */
const WITH_INPUT = ['compact', 'autocompact', 'name', 'steering', 'follow-up'] as const

function hintOf(name: OwnCommand): string | null {
  const input = (WITH_INPUT as readonly string[]).includes(name)
    ? (name as (typeof WITH_INPUT)[number])
    : null
  return input ? t(`pi.command.${input}.hint`) : null
}

export interface ParsedCommand {
  name: OwnCommand
  rest: string
}

/** The command of Kettu's own a prompt's text starts with; null for any other prompt. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const word = trimmed.slice(1).split(/\s+/)[0] ?? ''
  const name = OWN.find((command) => command === word)
  return name ? { name, rest: trimmed.slice(1 + word.length).trim() } : null
}

/** The commands a session offers: pi's own first, then Kettu's for pi, each name once. */
export function commandList(listed: readonly PiCommandInfo[]): SlashCommand[] {
  const commands = new Map<string, SlashCommand>()
  for (const command of listed) {
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    if (!name || commands.has(name)) continue
    const description = typeof command.description === 'string' ? command.description.trim() : ''
    commands.set(name, { name, description: description || `(${command.source})` })
  }
  for (const name of OWN) {
    if (commands.has(name)) continue
    const hint = hintOf(name)
    commands.set(name, {
      name,
      description: t(`pi.command.${name}.description`),
      ...(hint ? { inputHint: hint } : {}),
    })
  }
  return [...commands.values()]
}

/** `/autocompact`'s word as the state it asks for; null to toggle. */
export function autoCompactWord(word: string): boolean | null {
  const mode = word.toLowerCase()
  if (['on', 'true', 'enable', 'enabled'].includes(mode)) return true
  if (['off', 'false', 'disable', 'disabled'].includes(mode)) return false
  return null
}

/** `/steering`'s and `/follow-up`'s word as a delivery mode; null for any other word. */
export function queueMode(word: string): 'all' | 'one-at-a-time' | null {
  const mode = word.toLowerCase()
  return mode === 'all' || mode === 'one-at-a-time' ? mode : null
}

/** `/session`: the session's id and file, its messages, cost and tokens. */
export function statsMessage(stats: PiStats): string {
  const lines: string[] = []
  if (stats.sessionId) lines.push(t('pi.session.id', { value: stats.sessionId }))
  if (stats.sessionFile) lines.push(t('pi.session.file', { value: stats.sessionFile }))
  if (typeof stats.totalMessages === 'number') {
    lines.push(t('pi.session.messages', { value: stats.totalMessages }))
  }
  if (typeof stats.cost === 'number') {
    lines.push(t('pi.session.cost', { value: `$${stats.cost.toFixed(4)}` }))
  }
  const tokens = stats.tokens
  if (tokens) {
    const parts = [
      typeof tokens.input === 'number' ? t('pi.session.input', { value: tokens.input }) : null,
      typeof tokens.output === 'number' ? t('pi.session.output', { value: tokens.output }) : null,
      typeof tokens.cacheRead === 'number'
        ? t('pi.session.cacheRead', { value: tokens.cacheRead })
        : null,
      typeof tokens.cacheWrite === 'number'
        ? t('pi.session.cacheWrite', { value: tokens.cacheWrite })
        : null,
      typeof tokens.total === 'number' ? t('pi.session.total', { value: tokens.total }) : null,
    ].filter((part): part is string => part !== null)
    if (parts.length > 0) lines.push(t('pi.session.tokens', { value: parts.join(', ') }))
  }
  // Two trailing spaces end each line, as a Markdown line break.
  return lines.join('  \n')
}
