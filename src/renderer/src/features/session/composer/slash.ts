import type { SlashCommand } from '@shared/thread'

/** The commands whose name holds the query, those that start with it first, each in the agent's order. */
export function orderSlashMatches(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.toLowerCase()
  const starts: SlashCommand[] = []
  const contains: SlashCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) starts.push(command)
    else if (name.includes(needle)) contains.push(command)
  }
  return [...starts, ...contains]
}

/**
 * The length of the command the text starts with: `/` and one of the names exactly, case included,
 * since the agent receives the text as typed, then a space, a line break or nothing. 0 for none.
 */
export function leadingCommand(text: string, names: readonly string[]): number {
  const match = /^\/(\S+)(?=[ \n]|$)/.exec(text)
  return match && names.includes(match[1]) ? match[0].length : 0
}
