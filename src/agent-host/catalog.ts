// The built-in agents: the only place that knows how to launch one.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentCliSource } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { CONFIG_VARIABLES, type HostSettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { compareInstalls, listInstalled, type InstalledAdapter } from './adapter-install'
import type { BinaryInstalls } from './binary-install'
import { codexLaunchEnv, type AdapterLookup } from './codex-binary'
import { findCommand, needsShell, type Env } from './find-command'
import { t, type HostKey } from './i18n'
import {
  CLAUDE_CLI,
  CLI_FILES,
  CODEX_CLI,
  decideCli,
  findInstalledCli,
  type AdapterCli,
  type CliDecision,
  type CliFiles,
  type CliProbe,
} from './installed-cli'
import { satisfiesNode, type ConfigFolder, type NodeProbe } from './shell-env'
import { compareVersions } from './versions'

export type LaunchKind =
  // Installed from npm into the data directory and run on the user's Node.js. With `perSession`,
  // through the session router, which gives each session an adapter process of its own.
  | { kind: 'package'; package: string; version: string; perSession?: true }
  | { kind: 'binary'; command: string; args: string[] }
  // A script run with Electron's own Node.js, so it needs no Node.js on the machine.
  | { kind: 'node-script'; script: string }

/** A program the adapter runs, which the user installs beside it. */
export interface AgentRequires {
  /** The command looked up on PATH. */
  command: string
  /** The oldest version the adapter runs. */
  minimum: string
  /** The variable the adapter reads to run it instead. */
  variable: string
}

export interface AgentDefinition {
  id: AgentId
  name: string
  registryId: string
  launch: LaunchKind
  requiresNode?: string
  /** A program the adapter runs and the user installs, such as pi's `pi` (pi-acp 0.0.34). */
  requires?: AgentRequires
  /** Variables every launch adds (pi-acp 0.0.34 reads PI_ACP_ENABLE_EMBEDDED_CONTEXT). */
  env?: Record<string, string>
  install: { hint: HostKey; url: string }
  /**
   * Its terminal sign-in runs the `requires` program alone, without the launch's variables
   * (pi-acp 0.0.34's `pi_terminal_login` only runs `pi --terminal-login`).
   */
  signInWithCli?: true
  /**
   * Sends its thought levels again as legacy `modes`, which the host ignores, so no mode picker
   * repeats them (pi-acp 0.0.34's `thought_level` option).
   */
  levelsAsModes?: true
  /**
   * Sends the agent's startup note as the session's first `agent_message_chunk` after
   * `session/new`, which the host drops (pi-acp 0.0.34's `_meta.piAcp.startupInfo`).
   */
  startupNote?: true
  /** Pushes `_auth/status_update` as it starts, naming its account. */
  reportsAccount?: boolean
  /**
   * Writes progress notes as messages before its tool calls, Codex's commentary. Its adapter does
   * not say which messages they are (codex-acp sends the phase to JetBrains AIR clients only), so
   * the thread tells them by the work that follows.
   */
  progressNotes?: boolean
  /**
   * Replays each part of a thought as a chunk of its own with nothing between them, where its live
   * turns send a blank line between parts (codex-acp 2.2.2).
   */
  replaysThoughtParts?: boolean
  /**
   * Keeps MCP servers by name for each folder rather than each session, and names the session on
   * each tool call, so the artifacts service gives its process one token per folder.
   */
  mcpServersByName?: boolean
  /** Variables a package agent's launch adds, from what its install holds. */
  launchEnv?(lookup: AdapterLookup): Promise<Record<string, string>>
  /** How OverBench can install a binary agent for the user. */
  installs?: BinaryInstalls
  /** The CLI a package agent's adapter runs, which the user may have installed themselves. */
  cli?: AdapterCli
  /** The variable that moves its configuration folder, set to the folder picked in Settings. */
  configVariable?: string
  /**
   * The file in which it keeps MCP servers of its own, besides its settings file: `project` is a
   * project's own, relative to its folder, and `listCommand` lists them in a session.
   */
  mcpConfig?: { project: string; listCommand?: string }
}

const NODE_INSTALL: AgentDefinition['install'] = {
  hint: 'detect.hint.node',
  url: 'https://nodejs.org/en/download',
}

export const CLAUDE_CODE: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  registryId: 'claude-acp',
  launch: { kind: 'package', package: '@agentclientprotocol/claude-agent-acp', version: '0.94.0' },
  requiresNode: '>=22',
  install: NODE_INSTALL,
  reportsAccount: true,
  cli: CLAUDE_CLI,
  configVariable: CONFIG_VARIABLES['claude-code'],
  mcpConfig: { project: '.mcp.json', listCommand: '/mcp' },
}

export const CODEX: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  registryId: 'codex-acp',
  launch: { kind: 'package', package: '@agentclientprotocol/codex-acp', version: '2.2.2' },
  requiresNode: '>=22',
  install: NODE_INSTALL,
  reportsAccount: true,
  progressNotes: true,
  replaysThoughtParts: true,
  launchEnv: codexLaunchEnv,
  cli: CODEX_CLI,
  configVariable: CONFIG_VARIABLES.codex,
  mcpConfig: { project: '.codex/config.toml', listCommand: '/mcp' },
}

export const PI: AgentDefinition = {
  id: 'pi',
  name: 'Pi',
  registryId: 'pi-acp',
  // pi-acp keeps one live session per process, so every session gets an adapter process of its own.
  launch: { kind: 'package', package: 'pi-acp', version: '0.0.34', perSession: true },
  requiresNode: '>=22',
  requires: { command: 'pi', minimum: '0.81.0', variable: 'PI_ACP_PI_COMMAND' },
  // pi-acp 0.0.34 advertises embedded context only with this set, so attached files keep their text.
  env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' },
  // pi-acp 0.0.34's one auth method just runs `pi`, so the sign-in command is `pi` alone.
  signInWithCli: true,
  // pi-acp 0.0.34 sends its thought levels again as legacy modes.
  levelsAsModes: true,
  // pi-acp 0.0.34 sends pi's startup note as the session's first agent message.
  startupNote: true,
  install: {
    hint: 'detect.hint.pi',
    url: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md',
  },
}

export const OPENCODE: AgentDefinition = {
  id: 'opencode',
  name: 'OpenCode',
  registryId: 'opencode',
  launch: { kind: 'binary', command: 'opencode', args: ['acp'] },
  // Seen in OpenCode 2.0.32: every attach adds its servers to the folder, replacing a same name,
  // and every tool call carries `_meta["ai.opencode/sessionID"]`.
  mcpServersByName: true,
  mcpConfig: { project: 'opencode.json' },
  install: {
    hint: 'detect.hint.opencode',
    url: 'https://opencode.ai/docs/',
  },
  // The routes https://opencode.ai/docs lists for OpenCode 1, checked on 2026-10-22.
  installs: {
    brew: 'anomalyco/tap/opencode',
    script: 'https://opencode.ai/install',
    scriptBin: ['.opencode', 'bin'],
    npm: 'opencode-ai',
  },
}

export function fakeAgent(script: string): AgentDefinition {
  return {
    id: 'fake-agent',
    name: 'Fake agent',
    registryId: 'fake-agent',
    launch: { kind: 'node-script', script },
    install: {
      hint: 'detect.hint.fakeAgent',
      url: 'https://agentclientprotocol.com',
    },
    reportsAccount: true,
  }
}

/** The catalog; the fake agent exists only when main passes its path. */
export function buildCatalog(fakeAgentPath: string | null): AgentDefinition[] {
  const catalog = [CLAUDE_CODE, CODEX, OPENCODE, PI]
  if (fakeAgentPath) catalog.push(fakeAgent(fakeAgentPath))
  return catalog
}

/** The configuration folder picked for each agent whose folder can be moved. */
export function configFolders(
  catalog: readonly AgentDefinition[],
  agents: HostSettings['agents'],
): Partial<Record<AgentId, ConfigFolder>> {
  const folders: Partial<Record<AgentId, ConfigFolder>> = {}
  for (const def of catalog) {
    const folder = agents[def.id]?.configDir
    if (def.configVariable && folder)
      folders[def.id] = { variable: def.configVariable, path: folder }
  }
  return folders
}

/** A command line as words, for display and for building terminal sign-in commands. */
export interface CommandWords {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface LaunchSpec {
  /** An absolute path to the program. */
  command: string
  args: string[]
  /** Variables added for this agent only. */
  env: Record<string, string>
  /** True only for a resolved `.cmd` or `.bat` on Windows. */
  shell: boolean
  display: CommandWords
  /** The user's own CLI this launch passes to the adapter; a start that fails with it runs the copy. */
  cli?: string
}

/** Where a package agent's pinned version lives once installed, before detection says more. */
export function packageDir(adaptersDir: string, def: AgentDefinition): string | null {
  const { launch } = def
  if (launch.kind !== 'package') return null
  return path.join(adaptersDir, def.id, launch.version, 'node_modules', launch.package)
}

/** How the launch reads to the user, before or after detection. */
export function displayCommand(
  def: AgentDefinition,
  electronPath: string,
  binaryOverride: string | null,
  adaptersDir: string,
  sessionRouterPath: string | null = null,
): CommandWords {
  switch (def.launch.kind) {
    case 'package': {
      const entry = packageDir(adaptersDir, def) ?? ''
      // A per-session agent reads as the router's own command line.
      const args =
        def.launch.perSession && sessionRouterPath ? [sessionRouterPath, 'node', entry] : [entry]
      return { command: 'node', args, env: { ...def.env } }
    }
    case 'binary':
      return { command: binaryOverride ?? def.launch.command, args: def.launch.args, env: {} }
    case 'node-script':
      return {
        command: electronPath,
        args: [def.launch.script],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }
  }
}

/** What a package agent has installed, and what it needs to install the pinned version. */
export interface AdapterPlan {
  package: string
  /** The pinned version, the oldest that runs; the first start installs it. */
  version: string
  /** Whether an install of the pinned version or a newer one exists. */
  installed: boolean
  /** The install a start runs: the newest version from the pin up, the latest install on a tie. */
  current: InstalledAdapter | null
  node: string
  nodeVersion: string
  npm: string | null
  /** The newest install below the pin, run when the pinned one cannot be installed. */
  fallback: { version: string; dir: string; spec: LaunchSpec } | null
  /**
   * Which CLI the adapter runs, for an agent with a `cli`. `needsCopy`: the install a start runs
   * has no CLI of its own, which the copy needs, so the start installs it again with one.
   */
  cli: (CliDecision & { needsCopy: boolean }) | null
}

export type Detection =
  // `spec` is null for a package agent until its pinned version, or a newer one, is installed.
  | {
      state: 'available'
      spec: LaunchSpec | null
      adapter: AdapterPlan | null
      /** A `requires` program that was found, and the version it printed. */
      requires?: { program: string; version: string }
    }
  | { state: 'not-installed' | 'node-missing' | 'node-outdated'; detail: string }

/** `node <entry>`, or `node <router> node <entry>` for a per-session agent. */
export function packageSpec(
  node: string,
  entry: string,
  platform: Platform,
  env: Record<string, string> = {},
  prefix: string[] = [],
): LaunchSpec {
  const args = [...prefix, entry]
  return {
    command: node,
    args,
    env,
    shell: needsShell(node, platform),
    display: { command: node, args, env },
  }
}

/** `node <entry>` for an installed adapter, with what its `launchEnv` and `requires` add. */
export async function installedSpec(
  def: AgentDefinition,
  node: string,
  installed: InstalledAdapter,
  lookup: Omit<AdapterLookup, 'dir' | 'entry'>,
  extraEnv: Record<string, string> = {},
  sessionRouterPath: string | null = null,
): Promise<LaunchSpec> {
  const env = {
    ...def.env,
    ...extraEnv,
    ...(await def.launchEnv?.({ ...lookup, dir: installed.dir, entry: installed.entry })),
  }
  const prefix =
    def.launch.kind === 'package' && def.launch.perSession && sessionRouterPath
      ? [sessionRouterPath, node]
      : []
  return packageSpec(node, installed.entry, lookup.platform, env, prefix)
}

export interface DetectContext {
  platform: Platform
  env: Env
  electronPath: string
  binaryOverride: string | null
  node: NodeProbe
  /** `<userData>/agents`, where package agents are installed. */
  adaptersDir: string
  /** The session router every per-session agent launches through; null in a test without one. */
  sessionRouterPath?: string | null
  isExecutable(file: string): Promise<boolean>
  isFile?(file: string): Promise<boolean>
  realpath?(file: string): Promise<string>
  installed?(agentId: AgentId, packageName: string): Promise<InstalledAdapter[]>
  /** Asks a CLI its version; without it, no installed CLI is looked for. */
  probeCli?: CliProbe
  cliFiles?: CliFiles
  cliPreference?: AgentCliSource
  /** The installed CLI a start failed with, which is not used again until this is cleared. */
  cliFailure?: { path: string; reason: string } | null
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** Finds what an agent needs without starting it, so it can run at startup and on demand. */
export async function detectAgent(def: AgentDefinition, ctx: DetectContext): Promise<Detection> {
  const display = displayCommand(
    def,
    ctx.electronPath,
    ctx.binaryOverride,
    ctx.adaptersDir,
    ctx.sessionRouterPath ?? null,
  )
  const launch = def.launch
  switch (launch.kind) {
    case 'package': {
      const { nodePath, nodeVersion, npmPath } = ctx.node
      if (!nodePath || !nodeVersion) {
        return {
          state: 'node-missing',
          detail: t('detect.nodeMissing', { agent: def.name }),
        }
      }
      if (def.requiresNode && !satisfiesNode(nodeVersion, def.requiresNode)) {
        return {
          state: 'node-outdated',
          detail: t('detect.nodeOutdated', {
            agent: def.name,
            required: def.requiresNode.replace('>=', ''),
            installed: nodeVersion,
          }),
        }
      }
      const installed = (
        await (ctx.installed ?? ((id, name) => listInstalled(ctx.adaptersDir, id, name)))(
          def.id,
          launch.package,
        )
      ).toSorted((a, b) => compareInstalls(b, a))
      const fromPin = (adapter: InstalledAdapter): number =>
        compareVersions(adapter.version, launch.version)
      const current = installed.find((adapter) => fromPin(adapter) >= 0)
      const other = installed.find((adapter) => fromPin(adapter) < 0)
      if (!current && !npmPath && !other) {
        return {
          state: 'not-installed',
          detail: t('detect.npmMissing', { agent: def.name, hint: t(def.install.hint) }),
        }
      }
      // A program the adapter runs, which the user installs: pi-acp needs the user's own `pi`.
      let requires: { program: string; version: string } | null = null
      if (def.requires) {
        const hint = t(def.install.hint)
        const program = await findCommand(def.requires.command, ctx)
        if (!program) {
          return {
            state: 'not-installed',
            detail: t('detect.requiresMissing', {
              agent: def.name,
              command: def.requires.command,
              hint,
            }),
          }
        }
        const answer = ctx.probeCli
          ? await ctx.probeCli(program, ctx.env)
          : { error: `${def.requires.command} --version was not asked.` }
        if ('error' in answer) {
          return {
            state: 'not-installed',
            detail: t('detect.requiresFailed', {
              agent: def.name,
              command: def.requires.command,
              reason: answer.error,
              hint,
            }),
          }
        }
        if (compareVersions(answer.version, def.requires.minimum) < 0) {
          return {
            state: 'not-installed',
            detail: t('detect.requiresOutdated', {
              agent: def.name,
              command: def.requires.command,
              required: def.requires.minimum,
              installed: answer.version,
              hint,
            }),
          }
        }
        requires = { program, version: answer.version }
      }
      const requiresEnv =
        requires && def.requires ? { [def.requires.variable]: requires.program } : {}
      // A per-session agent runs only through the router, which every packaged build carries.
      if (launch.perSession && !ctx.sessionRouterPath) {
        return { state: 'not-installed', detail: 'The session router is missing from this build.' }
      }
      const prefix =
        launch.perSession && ctx.sessionRouterPath ? [ctx.sessionRouterPath, nodePath] : []
      const lookup = {
        platform: ctx.platform,
        env: ctx.env,
        ...(ctx.isFile ? { isFile: ctx.isFile } : {}),
        ...(ctx.realpath ? { realpath: ctx.realpath } : {}),
      }
      const files = ctx.cliFiles ?? CLI_FILES
      const found =
        def.cli && ctx.probeCli
          ? await findInstalledCli(def.cli, { ...ctx, files, probe: ctx.probeCli })
          : null
      // Until the pinned version is installed, the older install a start falls back to says it.
      const runs = current ?? other
      const decision = def.cli
        ? decideCli({
            prefer: ctx.cliPreference ?? 'installed',
            found: found?.installed ?? null,
            minimum:
              found && runs ? await def.cli.minimum(runs.dir, launch.package, files) : undefined,
            failure: ctx.cliFailure ?? null,
          })
        : null
      // A program the environment names reaches the adapter by itself.
      const passed =
        def.cli && decision?.runs === 'installed' && found && !found.installed.variable
          ? found
          : null
      const specFor = async (install: InstalledAdapter): Promise<LaunchSpec | null> => {
        if (passed && def.cli) {
          const env = {
            ...def.env,
            ...requiresEnv,
            ...passed.env,
            [def.cli.variable]: passed.installed.path,
          }
          return {
            ...packageSpec(nodePath, install.entry, ctx.platform, env, prefix),
            cli: passed.installed.path,
          }
        }
        if (install.withoutCli && decision?.runs !== 'installed') return null
        return installedSpec(
          def,
          nodePath,
          install,
          lookup,
          requiresEnv,
          ctx.sessionRouterPath ?? null,
        )
      }
      const spec = current ? await specFor(current) : null
      const fallbackSpec = other ? await specFor(other) : null
      return {
        state: 'available',
        spec,
        adapter: {
          package: launch.package,
          version: launch.version,
          installed: !!current,
          current: current ?? null,
          node: nodePath,
          nodeVersion,
          npm: npmPath,
          fallback:
            other && fallbackSpec
              ? { version: other.version, dir: other.dir, spec: fallbackSpec }
              : null,
          cli: decision ? { ...decision, needsCopy: !!current && !spec } : null,
        },
        ...(requires ? { requires } : {}),
      }
    }
    case 'binary': {
      const program = ctx.binaryOverride
        ? (await ctx.isExecutable(ctx.binaryOverride))
          ? ctx.binaryOverride
          : null
        : await findCommand(launch.command, ctx)
      if (!program) {
        return {
          state: 'not-installed',
          detail: ctx.binaryOverride
            ? t('detect.programUnusable', { agent: def.name, path: ctx.binaryOverride })
            : t('detect.commandMissing', { command: launch.command, hint: t(def.install.hint) }),
        }
      }
      return {
        state: 'available',
        spec: {
          command: program,
          args: [...launch.args],
          env: {},
          shell: needsShell(program, ctx.platform),
          display,
        },
        adapter: null,
      }
    }
    case 'node-script': {
      if (!(await (ctx.isFile ?? isFile)(launch.script))) {
        return {
          state: 'not-installed',
          detail: t('detect.scriptMissing', { script: launch.script }),
        }
      }
      return {
        state: 'available',
        spec: {
          command: ctx.electronPath,
          args: [launch.script],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          shell: false,
          display,
        },
        adapter: null,
      }
    }
  }
}
