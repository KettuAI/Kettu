// The built-in agents: the only place that knows how to launch one.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import { listInstalled, type InstalledAdapter } from './adapter-install'
import { findCommand, needsShell, type Env } from './find-command'
import { satisfiesNode, type NodeProbe } from './shell-env'

export type LaunchKind =
  // Installed from npm into the data directory and run on the user's Node.js.
  | { kind: 'package'; package: string; version: string }
  | { kind: 'binary'; command: string; args: string[] }
  // A script run with Electron's own Node.js, so it needs no Node.js on the machine.
  | { kind: 'node-script'; script: string }

export interface AgentDefinition {
  id: AgentId
  name: string
  registryId: string
  launch: LaunchKind
  requiresNode?: string
  install: { hint: string; url: string }
}

const NODE_INSTALL = {
  hint: 'Install Node.js 22 or later from nodejs.org, then reload the environment in Settings.',
  url: 'https://nodejs.org/en/download',
}

export const CLAUDE_CODE: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  registryId: 'claude-acp',
  launch: { kind: 'package', package: '@agentclientprotocol/claude-agent-acp', version: '0.94.0' },
  requiresNode: '>=22',
  install: NODE_INSTALL,
}

export const CODEX: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  registryId: 'codex-acp',
  launch: { kind: 'package', package: '@agentclientprotocol/codex-acp', version: '2.2.2' },
  requiresNode: '>=22',
  install: NODE_INSTALL,
}

export const OPENCODE: AgentDefinition = {
  id: 'opencode',
  name: 'OpenCode',
  registryId: 'opencode',
  launch: { kind: 'binary', command: 'opencode', args: ['acp'] },
  install: {
    hint: 'Install OpenCode, or choose its binary in Settings › Agents.',
    url: 'https://opencode.ai/docs/',
  },
}

export function fakeAgent(script: string): AgentDefinition {
  return {
    id: 'fake-agent',
    name: 'Fake agent',
    registryId: 'fake-agent',
    launch: { kind: 'node-script', script },
    install: {
      hint: 'The fake agent runs tools/fake-agent/main.ts from the repository.',
      url: 'https://agentclientprotocol.com',
    },
  }
}

/** The catalog; the fake agent exists only when main passes its path. */
export function buildCatalog(fakeAgentPath: string | null): AgentDefinition[] {
  const catalog = [CLAUDE_CODE, CODEX, OPENCODE]
  if (fakeAgentPath) catalog.push(fakeAgent(fakeAgentPath))
  return catalog
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
}

/** Where a package agent's pinned version lives once installed. */
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
): CommandWords {
  switch (def.launch.kind) {
    case 'package':
      return { command: 'node', args: [packageDir(adaptersDir, def) ?? ''], env: {} }
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
  version: string
  installed: boolean
  node: string
  nodeVersion: string
  npm: string | null
  /** The newest other installed version, run when the pinned one cannot be installed. */
  fallback: { version: string; spec: LaunchSpec } | null
}

export type Detection =
  // `spec` is null for a package agent until its pinned version is installed.
  | { state: 'available'; spec: LaunchSpec | null; adapter: AdapterPlan | null }
  | { state: 'not-installed' | 'node-missing' | 'node-outdated'; detail: string }

/** `node <entry>`, never through a shell unless `node` itself is a `.cmd` shim. */
export function packageSpec(node: string, entry: string, platform: Platform): LaunchSpec {
  return {
    command: node,
    args: [entry],
    env: {},
    shell: needsShell(node, platform),
    display: { command: node, args: [entry], env: {} },
  }
}

export interface DetectContext {
  platform: Platform
  env: Env
  electronPath: string
  binaryOverride: string | null
  node: NodeProbe
  /** `<userData>/agents`, where package agents are installed. */
  adaptersDir: string
  isExecutable(file: string): Promise<boolean>
  isFile?(file: string): Promise<boolean>
  installed?(agentId: AgentId, packageName: string): Promise<InstalledAdapter[]>
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
  const display = displayCommand(def, ctx.electronPath, ctx.binaryOverride, ctx.adaptersDir)
  const launch = def.launch
  switch (launch.kind) {
    case 'package': {
      const { nodePath, nodeVersion, npmPath } = ctx.node
      if (!nodePath || !nodeVersion) {
        return {
          state: 'node-missing',
          detail: `${def.name} runs on Node.js 22 or later, and node was not found on PATH.`,
        }
      }
      if (def.requiresNode && !satisfiesNode(nodeVersion, def.requiresNode)) {
        return {
          state: 'node-outdated',
          detail: `${def.name} needs Node.js ${def.requiresNode.replace('>=', '')} or later; ${nodeVersion} is installed.`,
        }
      }
      const installed = await (
        ctx.installed ?? ((id, name) => listInstalled(ctx.adaptersDir, id, name))
      )(def.id, launch.package)
      const pinned = installed.find((adapter) => adapter.version === launch.version)
      const other = installed.find((adapter) => adapter.version !== launch.version)
      if (!pinned && !npmPath && !other) {
        return {
          state: 'not-installed',
          detail: `${def.name} is installed with npm on first use, and npm was not found on PATH. ${def.install.hint}`,
        }
      }
      return {
        state: 'available',
        spec: pinned ? packageSpec(nodePath, pinned.entry, ctx.platform) : null,
        adapter: {
          package: launch.package,
          version: launch.version,
          installed: !!pinned,
          node: nodePath,
          nodeVersion,
          npm: npmPath,
          fallback: other
            ? { version: other.version, spec: packageSpec(nodePath, other.entry, ctx.platform) }
            : null,
        },
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
            ? `The program chosen for ${def.name} (${ctx.binaryOverride}) cannot be run.`
            : `${launch.command} was not found on PATH. ${def.install.hint}`,
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
        return { state: 'not-installed', detail: `${launch.script} does not exist.` }
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
