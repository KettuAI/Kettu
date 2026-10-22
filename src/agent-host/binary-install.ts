// Installing a binary agent such as OpenCode by one of its vendor's routes: Homebrew, the install
// script or npm. Every word comes from the catalog, the script's pipeline included, so nothing
// typed reaches a command line and an `npm.cmd` may run through cmd.exe.

import path from 'node:path'
import type { AgentInstallMethod } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { findCommand, type Env } from './find-command'
import { formatCommand } from './quote'

/** A binary agent's install routes, from its vendor's documentation. */
export interface BinaryInstalls {
  /** The Homebrew formula. */
  brew: string
  /** The install script's URL, piped to bash. */
  script: string
  /** The folder the script installs into, from the home directory. */
  scriptBin: string[]
  /** The npm package, installed globally. */
  npm: string
}

/** Progress and quiet for a global npm install; the page shows the command without them. */
export const NPM_GLOBAL_FLAGS = [
  '--no-fund',
  '--no-audit',
  '--no-update-notifier',
  '--loglevel=http',
] as const

export interface InstallPlan extends AgentInstallMethod {
  /** The program and its constant arguments; null while the tool it needs is not found. */
  run: { program: string; args: string[] } | null
  /** The tool found for it: brew, bash or npm. */
  tool: string | null
}

export interface PlanContext {
  platform: Platform
  env: Env
  /** npm as the Node.js probe found it. */
  npm: string | null
  isExecutable(file: string): Promise<boolean>
}

/** The routes in the order OverBench prefers; Homebrew and the script are macOS and Linux only. */
export async function installPlans(
  installs: BinaryInstalls,
  ctx: PlanContext,
): Promise<InstallPlan[]> {
  const { platform } = ctx
  const plans: InstallPlan[] = []
  if (platform === 'darwin' || platform === 'linux') {
    const [brew, bash, curl] = await Promise.all(
      ['brew', 'bash', 'curl'].map((name) => findCommand(name, ctx)),
    )
    const brewArgs = ['install', installs.brew]
    plans.push({
      id: 'brew',
      command: formatCommand({ command: 'brew', args: brewArgs }, platform),
      available: !!brew,
      run: brew ? { program: brew, args: brewArgs } : null,
      tool: brew ?? null,
    })
    const curlWords = { command: 'curl', args: ['-fsSL', installs.script] }
    const pipeline = `${formatCommand(curlWords, platform)} | bash`
    plans.push({
      id: 'script',
      command: pipeline,
      available: !!bash && !!curl,
      // With pipefail a download that fails fails the install, instead of bash running nothing.
      run: bash && curl ? { program: bash, args: ['-c', `set -o pipefail; ${pipeline}`] } : null,
      tool: bash ?? null,
    })
  }
  const npmArgs = ['install', '-g', installs.npm]
  plans.push({
    id: 'npm',
    command: formatCommand({ command: 'npm', args: npmArgs }, platform),
    available: !!ctx.npm,
    run: ctx.npm ? { program: ctx.npm, args: [...npmArgs, ...NPM_GLOBAL_FLAGS] } : null,
    tool: ctx.npm,
  })
  return plans
}

/**
 * The folder a route installs the agent's program into, named when it is still not found on
 * PATH afterwards. `npmPrefix` is `npm prefix -g`, asked only for the npm route.
 */
export async function installedFolder(
  plan: InstallPlan,
  installs: BinaryInstalls,
  ctx: { platform: Platform; home: string; npmPrefix(): Promise<string | null> },
): Promise<string | null> {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  switch (plan.id) {
    case 'brew':
      // Formulas link their programs beside brew itself, into `<prefix>/bin`.
      return plan.tool ? p.dirname(plan.tool) : null
    case 'script':
      return p.join(ctx.home, ...installs.scriptBin)
    case 'npm': {
      const prefix = await ctx.npmPrefix()
      if (!prefix) return null
      // npm links global programs into the prefix itself on Windows, and into its bin elsewhere.
      return ctx.platform === 'win32' ? prefix : p.join(prefix, 'bin')
    }
  }
}
