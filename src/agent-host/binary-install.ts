// Installing a harness's program such as OpenCode, Claude Code or Codex: by one of its vendor's
// routes (Homebrew, the install script, WinGet or npm), or by downloading the release archive the
// ACP Registry lists; and updating it by the route it was installed with. Every word of a route
// comes from the catalog, so nothing typed reaches a command line and an `npm.cmd` may run through
// cmd.exe.

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

/** A harness's install routes, from its vendor's documentation or the registry. */
export interface BinaryInstalls {
  /** The Homebrew formula. */
  brew?: string
  /** The Homebrew cask, in place of a formula. */
  brewCask?: string
  /** The install script's URL, piped to `scriptShell` (bash when not given). */
  script?: string
  scriptShell?: 'bash' | 'sh'
  /** The folder the script installs into, from the home directory. */
  scriptBin?: string[]
  /** Where the script keeps the program it installs, from the home directory, which tells it apart. */
  scriptHome?: string[]
  /** The program's own update command, for a script install that has one, such as `claude update`. */
  selfUpdate?: string[]
  /** The WinGet package id, on Windows. */
  winget?: string
  /** The npm package, installed globally. */
  npm?: string
  archive?: ArchiveRelease
  /** The routes in the vendor's order, the recommended first; archive, Homebrew, script, npm otherwise. */
  order?: AgentInstallMethod['id'][]
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

/** The install script piped to its shell, as `curl -fsSL <url> | bash`. */
function scriptPlan(
  url: string,
  shellName: string,
  shell: string | null,
  curl: string | null,
  platform: Platform,
): InstallPlan {
  const curlWords = { command: 'curl', args: ['-fsSL', url] }
  const download = formatCommand(curlWords, platform)
  const pipeline = `${download} | ${shellName}`
  // A download that fails must fail the install, not leave the shell running nothing. bash has
  // pipefail; a plain sh, such as dash before 0.5.12, may not, so it gets the script only once
  // curl succeeded.
  const script =
    shellName === 'bash'
      ? `set -o pipefail; ${pipeline}`
      : `script="$(${download})" && printf '%s\\n' "$script" | ${shellName}`
  return {
    id: 'script',
    label: pipeline,
    command: pipeline,
    available: !!shell && !!curl,
    run: shell && curl ? { program: shell, args: ['-c', script] } : null,
    tool: shell,
  }
}

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
  const brewName = installs.brewCask ?? installs.brew
  if ((platform === 'darwin' || platform === 'linux') && (brewName || installs.script)) {
    const shellName = installs.scriptShell ?? 'bash'
    const [brew, shell, curl] = await Promise.all(
      ['brew', shellName, 'curl'].map((name) => findCommand(name, ctx)),
    )
    // Casks are macOS only.
    if (brewName && !(installs.brewCask && platform !== 'darwin')) {
      const brewArgs = ['install', ...(installs.brewCask ? ['--cask'] : []), brewName]
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
    if (installs.script) plans.push(scriptPlan(installs.script, shellName, shell, curl, platform))
  }
  if (platform === 'win32' && installs.winget) {
    const winget = await findCommand('winget', ctx)
    const words = ['install', '--id', installs.winget, '-e']
    const command = formatCommand({ command: 'winget', args: words }, platform)
    plans.push({
      id: 'winget',
      label: command,
      command,
      available: !!winget,
      // Nothing may stop to ask: the install runs without a terminal.
      run: winget ? { program: winget, args: [...words, '--disable-interactivity'] } : null,
      tool: winget ?? null,
    })
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
  const order = installs.order
  if (!order) return plans
  const rank = (plan: InstallPlan): number => {
    const index = order.indexOf(plan.id)
    return index < 0 ? order.length : index
  }
  return plans.toSorted((a, b) => rank(a) - rank(b))
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
    case 'winget':
      return null
  }
}

/**
 * How the program at `realPath`, the file its command resolves to, was installed, told by where
 * it lives; null when Kettu cannot tell, as for a copy the user built or moved themselves.
 */
export function installMethodOf(
  installs: BinaryInstalls,
  realPath: string,
  ctx: { platform: Platform; home: string },
): AgentInstallMethod['id'] | null {
  const p = platformPath(ctx.platform)
  const file = ctx.platform === 'win32' ? realPath.toLowerCase().replaceAll('\\', '/') : realPath
  const under = (folder: string): boolean => {
    const base = ctx.platform === 'win32' ? folder.toLowerCase().replaceAll('\\', '/') : folder
    return file.startsWith(base.endsWith('/') ? base : `${base}/`)
  }
  if (installs.scriptHome && under(p.join(ctx.home, ...installs.scriptHome))) return 'script'
  if (installs.npm && file.includes(`/node_modules/${installs.npm}/`)) return 'npm'
  if ((installs.brew || installs.brewCask) && /\/(?:Cellar|Caskroom)\//.test(file)) return 'brew'
  if (installs.winget && file.includes('/winget/')) return 'winget'
  return null
}

/** How a program is updated: the command shown, and what runs it, or null while its tool is missing. */
export interface UpdatePlan {
  command: string
  run: { program: string; args: string[] } | null
}

/**
 * The update for the way the program was installed: its own update command or the install script
 * again, `brew upgrade`, `winget upgrade`, or `npm install -g` at the latest version.
 */
export async function updatePlan(
  installs: BinaryInstalls,
  method: AgentInstallMethod['id'],
  ctx: Pick<PlanContext, 'platform' | 'env' | 'npm' | 'isExecutable'> & { program: string },
): Promise<UpdatePlan | null> {
  const { platform } = ctx
  switch (method) {
    case 'script': {
      if (installs.selfUpdate) {
        const words = { command: path.basename(ctx.program), args: installs.selfUpdate }
        return {
          command: formatCommand(words, platform),
          run: { program: ctx.program, args: installs.selfUpdate },
        }
      }
      if (!installs.script) return null
      const shellName = installs.scriptShell ?? 'bash'
      const [shell, curl] = await Promise.all(
        [shellName, 'curl'].map((name) => findCommand(name, ctx)),
      )
      const plan = scriptPlan(installs.script, shellName, shell ?? null, curl ?? null, platform)
      return { command: plan.command, run: plan.run }
    }
    case 'brew': {
      const name = installs.brewCask ?? installs.brew
      if (!name) return null
      const brew = await findCommand('brew', ctx)
      const args = ['upgrade', ...(installs.brewCask ? ['--cask'] : []), name]
      return {
        command: formatCommand({ command: 'brew', args }, platform),
        run: brew ? { program: brew, args } : null,
      }
    }
    case 'winget': {
      if (!installs.winget) return null
      const winget = await findCommand('winget', ctx)
      const args = ['upgrade', '--id', installs.winget, '-e']
      return {
        command: formatCommand({ command: 'winget', args }, platform),
        run: winget ? { program: winget, args: [...args, '--disable-interactivity'] } : null,
      }
    }
    case 'npm': {
      if (!installs.npm) return null
      const args = ['install', '-g', `${installs.npm}@latest`]
      return {
        command: formatCommand({ command: 'npm', args }, platform),
        run: ctx.npm ? { program: ctx.npm, args: [...args, ...NPM_GLOBAL_FLAGS] } : null,
      }
    }
    case 'archive':
      return null
  }
}
