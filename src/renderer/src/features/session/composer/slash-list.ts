import type { KettuCommand } from '@shared/agent-host'
import { commandQualifier, type SlashCommand } from '@shared/thread'

/**
 * The slash list as the composer shows it: the app's own commands, the commands of Kettu's that
 * plugins and the user's folder hold, then the agent's. A name two of them share is listed for
 * each: the agent's own as it is, a file command with its source before it, as `plugin:command`,
 * which is what the host runs; a command of the app's own takes the agent's of its name.
 */
export function mergeCommands({
  builtin,
  kettu,
  agent,
}: {
  builtin: readonly SlashCommand[]
  kettu: readonly KettuCommand[]
  agent: readonly SlashCommand[]
}): SlashCommand[] {
  const builtinNames = new Set(builtin.map((command) => command.name))
  const agentNames = new Set(agent.map((command) => command.name))
  const counts = new Map<string, number>()
  for (const command of kettu) counts.set(command.name, (counts.get(command.name) ?? 0) + 1)
  const files = kettu.map((command): SlashCommand => {
    const clash =
      builtinNames.has(command.name) ||
      agentNames.has(command.name) ||
      counts.get(command.name)! > 1
    return {
      name: clash ? `${commandQualifier(command.origin)}:${command.name}` : command.name,
      description: command.description,
      ...(command.inputHint === undefined ? {} : { inputHint: command.inputHint }),
      source: command.origin,
    }
  })
  return [...builtin, ...files, ...agent.filter((command) => !builtinNames.has(command.name))]
}
