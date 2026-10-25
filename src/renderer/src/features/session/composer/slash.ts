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
