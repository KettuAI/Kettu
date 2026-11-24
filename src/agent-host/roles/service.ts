// Kettu's own roles: the files of the plugins that are on and of the user's folder, read for the
// list and for the instructions a session starts with, whichever agent runs it.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { KettuRole, RoleSuggests } from '@shared/agent-host'
import { PLUGIN_ITEM_NAME, type PluginResource } from '@shared/plugins'
import { commandQualifier, type CommandOrigin } from '@shared/thread'
import type { CommandNeeds } from '../commands/format'
import { unmetNeeds, type KeptTool } from '../commands/service'
import { invalidParams, notFound } from '../errors'
import { listOf, t } from '../i18n'
import type { LogFn } from '../storage'
import { parseRole, ROLE_FILE_BYTES, type RoleDefinition } from './format'

/** What the user's roles folder is called in the data folder the Marketplace keeps. */
export const USER_ROLES_DIR = path.join('marketplace', 'roles')

export interface RolesDeps {
  userDataPath: string
  /** The roles of the plugins that are on, each with its file. */
  plugins(): Promise<PluginResource[]>
  /** The skills and MCP servers the Marketplace keeps. */
  kept(): { skills: readonly KeptTool[]; mcp: readonly KeptTool[] }
  log: LogFn
}

/** A role a session can start as. */
export interface FoundRole {
  ref: string
  title: string
  /** The instructions the agent is given. */
  instructions: string
  suggests: RoleSuggests
  needs: CommandNeeds
}

interface Entry {
  name: string
  origin: CommandOrigin
  definition: RoleDefinition
}

export class RolesService {
  constructor(private readonly deps: RolesDeps) {}

  /** Where the user's own roles are kept, one `.md` file each. */
  get userDir(): string {
    return path.join(this.deps.userDataPath, USER_ROLES_DIR)
  }

  /** Every role the files hold, the user's first, so a name they share goes to the user's. */
  private async entries(): Promise<Entry[]> {
    const [user, plugins] = await Promise.all([this.userEntries(), this.pluginEntries()])
    return [...user, ...plugins]
  }

  private read(text: string, at: string): RoleDefinition | null {
    const parsed = parseRole(text)
    if (parsed.ok) return parsed.role
    this.deps.log('warn', `Left out the role ${at}: ${parsed.reason}`)
    return null
  }

  private async userEntries(): Promise<Entry[]> {
    let names: string[]
    try {
      names = await readdir(this.userDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log('warn', `Could not list the user's roles: ${(error as Error).message}`)
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

  /** A file's text, or null when it cannot be read or is larger than a role may be. */
  private async readFile(file: string): Promise<string | null> {
    try {
      if ((await stat(file)).size > ROLE_FILE_BYTES) {
        this.deps.log('warn', `Left out the role ${file}: it is larger than a role may be`)
        return null
      }
      return await readFile(file, 'utf8')
    } catch (error) {
      this.deps.log('warn', `Could not read the role ${file}: ${(error as Error).message}`)
      return null
    }
  }

  /** A role's reference: its name, qualified where another role has the same one. */
  private refOf(entry: Entry, all: readonly Entry[]): string {
    const shared = all.filter((other) => other.name === entry.name).length > 1
    return shared ? `${commandQualifier(entry.origin)}:${entry.name}` : entry.name
  }

  private describe(entry: Entry, all: readonly Entry[]): KettuRole {
    return {
      ref: this.refOf(entry, all),
      title: entry.definition.title ?? entry.name,
      description: entry.definition.description,
      suggests: entry.definition.suggests,
      origin: entry.origin,
    }
  }

  /** The roles for New session and the tools. */
  async list(): Promise<KettuRole[]> {
    const all = await this.entries()
    return all.map((entry) => this.describe(entry, all))
  }

  /** The role a reference names, the user's first when two share a name. */
  private async lookup(ref: string): Promise<{ entry: Entry; all: Entry[] } | null> {
    const all = await this.entries()
    const colon = ref.indexOf(':')
    const qualifier = colon > 0 ? ref.slice(0, colon) : null
    const name = colon > 0 ? ref.slice(colon + 1) : ref
    const entry = all.find(
      (item) =>
        item.name === name && (qualifier === null || commandQualifier(item.origin) === qualifier),
    )
    return entry ? { entry, all } : null
  }

  /** What a reference names, without its instructions; null when no role has it. */
  async get(ref: string): Promise<KettuRole | null> {
    const found = await this.lookup(ref)
    return found ? this.describe(found.entry, found.all) : null
  }

  /** The role a reference names with its instructions, or null when no role has it. */
  async find(ref: string): Promise<FoundRole | null> {
    const found = await this.lookup(ref)
    if (!found) return null
    const { entry, all } = found
    const { definition } = entry
    return {
      ref: this.refOf(entry, all),
      title: definition.title ?? entry.name,
      instructions: definition.body,
      suggests: definition.suggests,
      needs: definition.needs,
    }
  }

  /**
   * The role a session starts as. Throws when none matches, or when a skill or MCP server it
   * names is not installed or is turned off, so the session is not started without them.
   */
  async resolve(ref: string): Promise<FoundRole> {
    const found = await this.find(ref)
    if (!found) throw notFound(t('roles.unknown', { role: ref }))
    const unmet = unmetNeeds(this.deps.kept(), found.needs)
    if (unmet.length > 0) {
      throw invalidParams(t('roles.notStarted', { role: found.title, items: listOf(unmet) }))
    }
    return found
  }
}
