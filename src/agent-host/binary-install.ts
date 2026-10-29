// Installing a binary agent such as OpenCode: by one of its vendor's routes (Homebrew, the install
// script or npm), or by downloading the release archive the ACP Registry lists. Every word of a
// route comes from the catalog, so nothing typed reaches a command line and an `npm.cmd` may run
// through cmd.exe.

import path from 'node:path'
import type { AgentInstallMethod } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import { findCommand, type Env } from './find-command'
import { formatCommand } from './quote'

/** One platform's release archive, as the ACP Registry lists it. */
export interface ArchiveEntry {
  /** The file to download; for a bare executable, the program itself. */
  url: string
  /** The file's hash, which some registry entries do not give. */
  sha256?: string
  /** The program inside the archive, as the registry writes it. */
  cmd: string
  /** Arguments the program needs to speak ACP. */
  args?: string[]
  /** The download is the program itself, as sigit's Linux and Windows entries are. */
  bare?: true
}

/** An agent's archives, one entry per `<platform>-<arch>`, and the version they belong to. */
export interface ArchiveRelease {
  version: string
  entries: Record<string, ArchiveEntry>
}

/** A binary agent's install routes, from its vendor's documentation or the registry. */
export interface BinaryInstalls {
  /** The Homebrew formula. */
  brew?: string
  /** The install script's URL, piped to bash. */
  script?: string
  /** The folder the script installs into, from the home directory. */
  scriptBin?: string[]
  /** The npm package, installed globally. */
  npm?: string
  archive?: ArchiveRelease
}

/** Progress and quiet for a global npm install; the page shows the command without them. */
export const NPM_GLOBAL_FLAGS = [
  '--no-fund',
  '--no-audit',
  '--no-update-notifier',
  '--loglevel=http',
] as const

/** The registry's key for a platform and architecture, such as `darwin-aarch64`. */
export function archiveKey(platform: Platform, arch: string): string {
  const name = platform === 'win32' ? 'windows' : platform
  const machine = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${name}-${machine}`
}

/** The release's entry for a platform and architecture, when it ships one. */
export function archiveEntry(
  release: ArchiveRelease | undefined,
  platform: Platform,
  arch: string,
): ArchiveEntry | null {
  return release?.entries[archiveKey(platform, arch)] ?? null
}

/** The archive route's own fields, for the install Kettu downloads and extracts itself. */
export interface ArchivePlan {
  version: string
  url: string
  sha256?: string
  cmd: string
  args?: string[]
  bare?: true
  /** The folder that holds the installed program, named when it is still not found afterwards. */
  folder: string
}

export interface InstallPlan extends AgentInstallMethod {
  /** The program and its constant arguments; null while the tool it needs is not found. */
  run: { program: string; args: string[] } | null
  /** The tool found for it: brew, bash or npm. */
  tool: string | null
  archive?: ArchivePlan
}

export interface PlanContext {
  platform: Platform
  /** The machine's architecture, as Node.js names it (`arm64`, `x64`). */
  arch: string
  env: Env
  /** npm as the Node.js probe found it. */
  npm: string | null
  /** `<userData>/agents`, where the archive route installs. */
  root: string
  agentId: AgentId
  isExecutable(file: string): Promise<boolean>
}

/** The file an archive URL names, as the page shows the route. */
export function archiveFileName(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop()
    return name ? decodeURIComponent(name) : url
  } catch {
    return url
  }
}

const platformPath = (platform: Platform): typeof path.posix =>
  platform === 'win32' ? path.win32 : path.posix

/**
 * The routes in the order Kettu prefers; the archive comes first when the registry ships one
 * for this platform, then Homebrew and the script on macOS and Linux, then npm.
 */
export async function installPlans(
  installs: BinaryInstalls,
  ctx: PlanContext,
): Promise<InstallPlan[]> {
  const { platform } = ctx
  const plans: InstallPlan[] = []
  const release = installs.archive
  const entry = archiveEntry(release, platform, ctx.arch)
  if (release && entry) {
    const p = platformPath(platform)
    const folder = p.join(ctx.root, ctx.agentId, release.version, p.dirname(entry.cmd))
    plans.push({
      id: 'archive',
      label: archiveFileName(entry.url),
      command: entry.url,
      available: true,
      run: null,
      tool: null,
      archive: {
        version: release.version,
        url: entry.url,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        cmd: entry.cmd,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.bare ? { bare: true as const } : {}),
        folder,
      },
    })
  }
  if ((platform === 'darwin' || platform === 'linux') && (installs.brew || installs.script)) {
    const [brew, bash, curl] = await Promise.all(
      ['brew', 'bash', 'curl'].map((name) => findCommand(name, ctx)),
    )
    if (installs.brew) {
      const brewArgs = ['install', installs.brew]
      const command = formatCommand({ command: 'brew', args: brewArgs }, platform)
      plans.push({
        id: 'brew',
        label: command,
        command,
        available: !!brew,
        run: brew ? { program: brew, args: brewArgs } : null,
        tool: brew ?? null,
      })
    }
    if (installs.script) {
      const curlWords = { command: 'curl', args: ['-fsSL', installs.script] }
      const pipeline = `${formatCommand(curlWords, platform)} | bash`
      plans.push({
        id: 'script',
        label: pipeline,
        command: pipeline,
        available: !!bash && !!curl,
        // With pipefail a download that fails fails the install, instead of bash running nothing.
        run: bash && curl ? { program: bash, args: ['-c', `set -o pipefail; ${pipeline}`] } : null,
        tool: bash ?? null,
      })
    }
  }
  if (installs.npm) {
    const npmArgs = ['install', '-g', installs.npm]
    const command = formatCommand({ command: 'npm', args: npmArgs }, platform)
    plans.push({
      id: 'npm',
      label: command,
      command,
      available: !!ctx.npm,
      run: ctx.npm ? { program: ctx.npm, args: [...npmArgs, ...NPM_GLOBAL_FLAGS] } : null,
      tool: ctx.npm,
    })
  }
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
    case 'archive':
      return plan.archive?.folder ?? null
    case 'brew':
      // Formulas link their programs beside brew itself, into `<prefix>/bin`.
      return plan.tool ? p.dirname(plan.tool) : null
    case 'script':
      return installs.scriptBin ? p.join(ctx.home, ...installs.scriptBin) : null
    case 'npm': {
      const prefix = await ctx.npmPrefix()
      if (!prefix) return null
      // npm links global programs into the prefix itself on Windows, and into its bin elsewhere.
      return ctx.platform === 'win32' ? prefix : p.join(prefix, 'bin')
    }
  }
}
