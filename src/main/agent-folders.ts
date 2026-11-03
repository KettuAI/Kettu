// The agents a user adds beside a harness's default one, each with a configuration folder of its
// own: one Kettu makes under the user's home folder, or one picked in the folder dialog or typed
// on a device. A folder belongs to one agent, and an agent keeps its folder; only main, or the
// daemon, writes the paths into the settings.

import { cp, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import type { AddedAgent } from '@shared/settings'
import {
  addedAgentId,
  isAgentId,
  isHarnessId,
  MULTI_AGENT_HARNESSES,
  type AgentId,
  type HarnessId,
} from '@shared/thread'
import { t } from './i18n'
import type { SettingsStore } from './settings'
import { agentName, SettingsError } from './settings-schema'

/** The folder every harness that carries agents uses when nothing moves it, from the home folder. */
const DEFAULT_FOLDERS: Partial<Record<HarnessId, string>> = {
  'claude-code': '.claude',
  codex: '.codex',
}

async function resolved(folder: string): Promise<string> {
  const real = await realpath(folder).catch(() => folder)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

async function exists(folder: string): Promise<boolean> {
  return (await stat(folder).catch(() => null))?.isDirectory() ?? false
}

export class AgentFolders {
  /**
   * The folders the dialog returned this run, or a device typed and the host found, the only
   * existing ones an agent may be given.
   */
  private readonly picked = new Set<string>()

  constructor(
    private readonly settings: SettingsStore,
    /** `<home>/.kettu/agents`, where Kettu makes the folders of the agents it creates. */
    private readonly root: string,
    /** Moves a folder Kettu made out of the way: to the trash, or where the daemon keeps them. */
    private readonly trash: (folder: string) => Promise<void>,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  /**
   * Moves the folders Kettu made while they lived beside its own data, once: they belong to the
   * user and must outlive the app. A folder on another volume is copied.
   */
  async moveCreatedAgents(legacyRoot: string): Promise<void> {
    const agents = this.settings
      .get()
      .addedAgents.filter((agent) => agent.created && this.inside(legacyRoot, agent.configDir))
    if (agents.length === 0) return
    await mkdir(this.root, { recursive: true })
    for (const agent of agents) {
      const target = join(this.root, agent.id)
      try {
        if (!(await exists(target))) await this.moveFolder(agent.configDir, target)
        this.settings.moveAgent(agent.id, target)
      } catch (error) {
        this.log(`Could not move ${agent.configDir} to ${target}: ${(error as Error).message}`)
      }
    }
  }

  private async moveFolder(from: string, to: string): Promise<void> {
    try {
      await rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await cp(from, to, { recursive: true })
      await rm(from, { recursive: true, force: true })
    }
  }

  private inside(root: string, folder: string): boolean {
    const path = relative(root, folder)
    return path !== '' && !path.startsWith('..') && !isAbsolute(path)
  }

  /** Records a folder the user picked in the dialog or the host checked, which `add` may take. */
  remember(folder: string): void {
    this.picked.add(folder)
  }

  /**
   * Adds an agent to a harness that carries agents, with a new folder when `folder` is null.
   * Resolves to the new agent's id.
   */
  async add(harness: unknown, name: unknown, folder: unknown): Promise<AgentId> {
    if (!isHarnessId(harness) || !MULTI_AGENT_HARNESSES.includes(harness)) {
      throw new SettingsError(`Agents cannot be added to "${String(harness)}"`)
    }
    const shown = agentName(name)
    const current = this.settings.get()
    const id = addedAgentId(
      harness,
      shown,
      current.addedAgents.map((agent) => agent.id),
    )
    let configDir: string
    let created: boolean
    if (folder === null) {
      configDir = join(this.root, id)
      await mkdir(configDir, { recursive: true, mode: 0o700 })
      created = true
    } else {
      if (typeof folder !== 'string' || !this.picked.has(folder)) {
        throw new SettingsError('Choose the folder in the dialog')
      }
      await this.assertFree(harness, folder)
      configDir = folder
      created = false
    }
    const agent: AddedAgent = { id, name: shown, configDir, created }
    this.settings.addAgent(agent)
    return id
  }

  rename(agentId: unknown, name: unknown): void {
    if (!isAgentId(agentId)) throw new SettingsError(`Unknown agent "${String(agentId)}"`)
    this.settings.renameAgent(agentId, agentName(name))
  }

  /**
   * Removes an added agent. Its folder moves to the trash only when Kettu made it and the user
   * chose so; a folder the user picked stays as it is.
   */
  async remove(agentId: unknown, trash: unknown): Promise<void> {
    if (!isAgentId(agentId)) throw new SettingsError(`Unknown agent "${String(agentId)}"`)
    if (typeof trash !== 'boolean') throw new SettingsError('"trash" must be a boolean')
    const agent = this.settings.get().addedAgents.find((candidate) => candidate.id === agentId)
    if (!agent && !isHarnessId(agentId)) throw new SettingsError(`No added agent "${agentId}"`)
    this.settings.removeAgent(agentId)
    if (trash && agent?.created && this.inRoot(agent.configDir)) {
      await this.trash(agent.configDir)
    }
  }

  private inRoot(folder: string): boolean {
    return this.inside(this.root, folder)
  }

  /** Refuses a folder another agent already has: an added one, or a harness's default folder. */
  private async assertFree(harness: HarnessId, folder: string): Promise<void> {
    const wanted = await resolved(folder)
    const current = this.settings.get()
    for (const other of current.addedAgents) {
      if ((await resolved(other.configDir)) === wanted) {
        throw new SettingsError(t('agents.folderTaken', { agent: other.name }))
      }
    }
    for (const [id, name] of Object.entries(DEFAULT_FOLDERS) as [HarnessId, string][]) {
      const moved = current.agents[id]?.configDir
      const own = moved ?? join(os.homedir(), name)
      if ((await resolved(own)) === wanted) {
        throw new SettingsError(
          t('agents.folderTaken', { agent: id === 'claude-code' ? 'Claude Code' : 'Codex' }),
        )
      }
    }
    if (harness === 'claude-code' && wanted === (await resolved(this.root))) {
      throw new SettingsError(t('agents.folderTaken', { agent: 'Kettu' }))
    }
  }
}
