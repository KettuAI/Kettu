// Kettu's own slash commands: the files of the plugins that are on and of the user's folder, read
// for the list, and expanded into the plain message an agent gets, whichever agent it is.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { KettuCommand } from '@shared/agent-host'
import { PLUGIN_ITEM_NAME, type PluginResource } from '@shared/plugins'
import { commandQualifier, type CommandOrigin, type CommandRun } from '@shared/thread'
import { HostError } from '../errors'
import { listOf, t } from '../i18n'
import type { LogFn } from '../storage'
import {
  COMMAND_FILE_BYTES,
  fillCommand,
  inputHint,
  parseCommand,
  type CommandDefinition,
  type CommandNeeds,
} from './format'

/** What the user's commands folder is called in the data folder the Marketplace keeps. */
export const USER_COMMANDS_DIR = path.join('marketplace', 'commands')

/** A skill or MCP server the Marketplace keeps. */
export interface KeptTool {
  id: string
  name: string
  on: boolean
}

export interface CommandsDeps {
  userDataPath: string
  /** The commands of the plugins that are on, each with its file. */
  plugins(): Promise<PluginResource[]>
  /** The skills and MCP servers the Marketplace keeps. */
  kept(): { skills: readonly KeptTool[]; mcp: readonly KeptTool[] }
  log: LogFn
}

export interface CommandExpansion {
  run: CommandRun
  needs: CommandNeeds
}

interface Entry {
  name: string
  origin: CommandOrigin
  definition: CommandDefinition
}

export class CommandsService {
  constructor(private readonly deps: CommandsDeps) {}

  /** Where the user's own commands are kept, one `.md` file each. */
  get userDir(): string {
    return path.join(this.deps.userDataPath, USER_COMMANDS_DIR)
  }

  /** Every command the files hold, the user's first, so a name they share goes to the user's. */
  private async entries(): Promise<Entry[]> {
    const [user, plugins] = await Promise.all([this.userEntries(), this.pluginEntries()])
    return [...user, ...plugins]
  }

  private read(text: string, at: string): CommandDefinition | null {
    const parsed = parseCommand(text)
    if (parsed.ok) return parsed.command
    this.deps.log('warn', `Left out the command ${at}: ${parsed.reason}`)
    return null
  }

  private async userEntries(): Promise<Entry[]> {
    let names: string[]
    try {
      names = await readdir(this.userDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log('warn', `Could not list the user's commands: ${(error as Error).message}`)
      }
      return []
    }
    const out: Entry[] = []
    for (const file of names.sort()) {
      if (!file.endsWith('.md') || file.startsWith('.')) continue
      const name = file.slice(0, -'.md'.length)
      if (!PLUGIN_ITEM_NAME.test(name)) continue
      const text = await this.readFile(path.join(this.userDir, file))
      const definition = text === null ? null : this.read(text, file)
      if (definition) out.push({ name, origin: { kind: 'user' }, definition })
    }
    return out
  }

  private async pluginEntries(): Promise<Entry[]> {
    const out: Entry[] = []
    const resources = [...(await this.deps.plugins())].sort(
      (a, b) => a.pluginName.localeCompare(b.pluginName) || a.name.localeCompare(b.name),
    )
    for (const resource of resources) {
      const text = await this.readFile(resource.file)
      const definition =
        text === null ? null : this.read(text, `${resource.pluginName}:${resource.name}`)
      if (!definition) continue
      out.push({
        name: resource.name,
        origin: {
          kind: 'plugin',
          id: resource.pluginId,
          name: resource.pluginName,
          title: resource.plugin,
        },
        definition,
      })
    }
    return out
  }

  /** A file's text, or null when it cannot be read or is larger than a command may be. */
  private async readFile(file: string): Promise<string | null> {
    try {
      if ((await stat(file)).size > COMMAND_FILE_BYTES) {
        this.deps.log('warn', `Left out the command ${file}: it is larger than a command may be`)
        return null
      }
      return await readFile(file, 'utf8')
    } catch (error) {
      this.deps.log('warn', `Could not read the command ${file}: ${(error as Error).message}`)
      return null
    }
  }

  /** The commands for the slash list. */
  async list(): Promise<KettuCommand[]> {
    return (await this.entries()).map(({ name, origin, definition }) => {
      const hint = inputHint(definition)
      return {
        name,
        description: definition.description,
        ...(hint === undefined ? {} : { inputHint: hint }),
        origin,
      }
    })
  }

  /**
   * The message a text that starts with one of Kettu's commands expands to; null when it starts
   * with none, or with a name the agent has itself (`agentOwn`), which it takes as typed. Throws
   * when the command cannot go: an argument it needs has no value, or a skill or MCP server it
   * names is not installed or is turned off.
   */
  async expand(text: string, agentOwn: ReadonlySet<string>): Promise<CommandExpansion | null> {
    const typed = /^\/(\S+)(?=\s|$)/.exec(text)
    if (!typed || agentOwn.has(typed[1]!)) return null
    const colon = typed[1]!.indexOf(':')
    const qualifier = colon > 0 ? typed[1]!.slice(0, colon) : null
    const name = colon > 0 ? typed[1]!.slice(colon + 1) : typed[1]!
    const found = (await this.entries()).find(
      (entry) =>
        entry.name === name && (qualifier === null || commandQualifier(entry.origin) === qualifier),
    )
    if (!found) return null
    const { definition } = found
    const filled = fillCommand(definition, text.slice(typed[0].length))
    if (!filled.ok) {
      throw new HostError(
        'invalid_params',
        t('commands.missingArguments', { command: typed[1]!, names: filled.missing.join(', ') }),
      )
    }
    const needs = { skills: definition.skills, mcp: definition.mcp }
    const unmet = this.unmet(needs)
    if (unmet.length > 0) {
      throw new HostError(
        'invalid_params',
        t('commands.notSent', { command: typed[1]!, items: listOf(unmet) }),
      )
    }
    return { run: { name, origin: found.origin, sent: filled.text }, needs }
  }

  /** What a command needs that the Marketplace does not keep or has turned off, one line each. */
  private unmet(needs: CommandNeeds): string[] {
    return unmetNeeds(this.deps.kept(), needs)
  }
}

/** What `needs` names that the Marketplace does not keep or has turned off, one line each. */
export function unmetNeeds(
  kept: { skills: readonly KeptTool[]; mcp: readonly KeptTool[] },
  needs: CommandNeeds,
): string[] {
  const lines: string[] = []
  const check = (names: readonly string[], list: readonly KeptTool[], kind: 'skill' | 'mcp') => {
    for (const name of names) {
      const tool = list.find((item) => item.name === name || item.id === name)
      if (!tool) lines.push(t(`commands.missing.${kind}`, { name }))
      else if (!tool.on) lines.push(t(`commands.off.${kind}`, { name }))
    }
  }
  check(needs.skills, kept.skills, 'skill')
  check(needs.mcp, kept.mcp, 'mcp')
  return lines
}
