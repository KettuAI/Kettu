import type { KettuCommand } from '@shared/agent-host'
import { commandQualifier, type CommandSource, type SlashCommand } from '@shared/thread'

/**
 * The slash list as the composer shows it: the app's own commands, the commands of Kettu's that
 * plugins and the user's folder hold, then the agent's, each of its names once, since an older host
 * may send one twice. A name two of them share is listed for each: the agent's own as it is, a
 * file command with its source before it, as `plugin:command`, which is what the host runs; a
 * command of the app's own takes the agent's of its name.
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
  const agentOwn = new Map<string, SlashCommand>()
  for (const command of agent) {
    if (!builtinNames.has(command.name) && !agentOwn.has(command.name)) {
      agentOwn.set(command.name, command)
    }
  }
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
  return [...builtin, ...files, ...agentOwn.values()]
}

function sourceKey(source: CommandSource | undefined): string {
  if (!source) return 'agent'
  return source.kind === 'plugin' ? `plugin:${source.id}` : source.kind
}

/**
 * A key for each command of the list that no other shares: its source, its name and how many
 * before it had both. Commands that share a name keep their order through every query, so each
 * keeps its key as the matches reorder.
 */
export function slashKeys(commands: readonly SlashCommand[]): Map<SlashCommand, string> {
  const keys = new Map<SlashCommand, string>()
  const counts = new Map<string, number>()
  for (const command of commands) {
    const base = JSON.stringify([sourceKey(command.source), command.name])
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    keys.set(command, `${base}${count}`)
  }
  return keys
}
