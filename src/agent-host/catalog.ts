// The built-in agents: the only place that knows how to launch one.

import { stat } from 'node:fs/promises'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import { findCommand, needsShell, type Env } from './find-command'
import { satisfiesNode, type NodeProbe } from './shell-env'

export type LaunchKind =
  | { kind: 'npx'; package: string }
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
  launch: { kind: 'npx', package: '@agentclientprotocol/claude-agent-acp@0.94.0' },
  requiresNode: '>=22',
  install: NODE_INSTALL,
}

export const CODEX: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  registryId: 'codex-acp',
  launch: { kind: 'npx', package: '@agentclientprotocol/codex-acp@2.2.2' },
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

/** How the launch reads to the user, before or after detection. */
export function displayCommand(
  def: AgentDefinition,
  electronPath: string,
  binaryOverride: string | null,
): CommandWords {
  switch (def.launch.kind) {
    case 'npx':
      return { command: 'npx', args: ['-y', def.launch.package], env: {} }
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

export type Detection =
  | { state: 'available'; spec: LaunchSpec }
  | { state: 'not-installed' | 'node-missing' | 'node-outdated'; detail: string }

export interface DetectContext {
  platform: Platform
  env: Env
  electronPath: string
  binaryOverride: string | null
  node: NodeProbe
  isExecutable(file: string): Promise<boolean>
  isFile?(file: string): Promise<boolean>
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
  const display = displayCommand(def, ctx.electronPath, ctx.binaryOverride)
  const launch = def.launch
  switch (launch.kind) {
    case 'npx': {
      const npx = ctx.node.npxPath
      if (!npx || !ctx.node.nodeVersion) {
        return {
          state: 'node-missing',
          detail: `${def.name} runs through npx, which needs Node.js 22 or later. ${npx ? 'node' : 'npx'} was not found on PATH.`,
        }
      }
      if (def.requiresNode && !satisfiesNode(ctx.node.nodeVersion, def.requiresNode)) {
        return {
          state: 'node-outdated',
          detail: `${def.name} needs Node.js ${def.requiresNode.replace('>=', '')} or later; ${ctx.node.nodeVersion} is installed.`,
        }
      }
      return {
        state: 'available',
        spec: {
          command: npx,
          args: ['-y', launch.package],
          env: {},
          shell: needsShell(npx, ctx.platform),
          display,
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
      }
    }
  }
}
