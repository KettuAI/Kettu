// Installing a harness's program such as OpenCode, Claude Code or Codex: by one of its vendor's
// routes (Homebrew, the install script, WinGet or npm), or by downloading the release archive the
// ACP Registry lists; and updating it by the route it was installed with. Every word of a route
// comes from the catalog, so nothing typed reaches a command line and an `npm.cmd` may run through
// cmd.exe.

import path from 'node:path'
import type { AgentInstallMethod, ProgramMethod } from '@shared/agent-host'
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

/**
 * The release archive route. Its version and each platform's file come from the versions Kettu
 * reads at run time, the Registry's or the bundled ones, never from the catalog.
 */
export interface ArchiveRoute {
  /** From the vendor's own release list rather than the registry's, so no update follows it. */
  fromVendor?: true
  /** The oldest version the mapping accepts; the Registry's older ones are not used. */
  minimum?: string
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
  /** Constant arguments passed to the script through the shell's stdin mode. */
  scriptArgs?: string[]
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
  /**
   * The dist-tag the vendor's install names, such as `prerelease`, which installs and updates take
   * in place of `latest`. Removing and finding the program use the bare package.
   */
  npmTag?: string
  /** The npm route skips the package's install scripts, as the vendor's own command does. */
  ignoreScripts?: true
  archive?: ArchiveRoute
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

/** The package at `at`, the vendor's dist-tag by default, or the bare name when there is none. */
function npmSpec(installs: BinaryInstalls, at = installs.npmTag): string {
  return at ? `${installs.npm}@${at}` : (installs.npm ?? '')
}

/** The registry's key for a platform and architecture, such as `darwin-aarch64`. */
export function archiveKey(platform: Platform, arch: string): string {
  const name = platform === 'win32' ? 'windows' : platform
  const machine = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${name}-${machine}`
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
  env: Env
  /** npm as the Node.js probe found it. */
  npm: string | null
  /** `<userData>/agents`, where the archive route installs. */
  root: string
  agentId: AgentId
  /** The archive a first install takes on this platform, at the version a start wants. */
  archive?: { version: string; entry: ArchiveEntry } | null
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
  args: string[] = [],
): InstallPlan {
  const curlWords = { command: 'curl', args: ['-fsSL', url] }
  const download = formatCommand(curlWords, platform)
  const invocation = formatCommand(
    { command: shellName, args: args.length ? ['-s', '--', ...args] : [] },
    platform,
  )
  const pipeline = `${download} | ${invocation}`
  // A download that fails must fail the install, not leave the shell running nothing. bash has
  // pipefail; a plain sh, such as dash before 0.5.12, may not, so it gets the script only once
  // curl succeeded.
  const script =
    shellName === 'bash'
      ? `set -o pipefail; ${pipeline}`
      : `script="$(${download})" && printf '%s\\n' "$script" | ${invocation}`
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
  const release = installs.archive ? ctx.archive : null
  if (release) {
    const { entry } = release
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
    if (installs.script) {
      plans.push(scriptPlan(installs.script, shellName, shell, curl, platform, installs.scriptArgs))
    }
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
    const npmArgs = [
      'install',
      '-g',
      ...(installs.ignoreScripts ? ['--ignore-scripts'] : []),
      npmSpec(installs),
    ]
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
  const npmPrefix = plan.id === 'npm' ? await ctx.npmPrefix() : null
  return routeFolder(plan, installs, { ...ctx, npmPrefix })
}

/**
 * The folder a route puts the program into, as far as Kettu can tell before it runs; `npmPrefix`
 * is npm's global prefix, which only the npm route needs.
 */
export function routeFolder(
  plan: InstallPlan,
  installs: BinaryInstalls,
  ctx: { platform: Platform; home: string; npmPrefix: string | null },
): string | null {
  const p = platformPath(ctx.platform)
  switch (plan.id) {
    case 'archive':
      return plan.archive?.folder ?? null
    case 'brew':
      // Formulas link their programs beside brew itself, into `<prefix>/bin`.
      return plan.tool ? p.dirname(plan.tool) : null
    case 'script':
      return installs.scriptBin ? p.join(ctx.home, ...installs.scriptBin) : null
    case 'npm':
      if (!ctx.npmPrefix) return null
      // npm links global programs into the prefix itself on Windows, and into its bin elsewhere.
      return ctx.platform === 'win32' ? ctx.npmPrefix : p.join(ctx.npmPrefix, 'bin')
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
): ProgramMethod | null {
  const p = platformPath(ctx.platform)
  const file = ctx.platform === 'win32' ? realPath.toLowerCase().replaceAll('\\', '/') : realPath
  const under = (folder: string): boolean => {
    const base = ctx.platform === 'win32' ? folder.toLowerCase().replaceAll('\\', '/') : folder
    return file.startsWith(base.endsWith('/') ? base : `${base}/`)
  }
  if (installs.scriptHome && under(p.join(ctx.home, ...installs.scriptHome))) return 'script'
  const global = installs.npm ? globalInstallOf(realPath, installs.npm, ctx.platform) : null
  if (global) return global.manager
  // A formula's keg is named for it, which tells OpenCode 2's formula from OpenCode 1's.
  const formula = installs.brew?.split('/').pop()
  if (formula && file.includes(`/Cellar/${formula}/`)) return 'brew'
  if (installs.brewCask && file.includes('/Caskroom/')) return 'brew'
  if (installs.winget && file.includes('/winget/')) return 'winget'
  return null
}

/** A package manager whose global installs Kettu tells apart. */
export type PackageManager = Extract<ProgramMethod, 'npm' | 'pnpm' | 'bun' | 'yarn'>

/** A program a package manager installed globally, and the folder its commands name. */
export interface GlobalInstall {
  manager: PackageManager
  /**
   * npm's prefix, pnpm's global dir or yarn's global folder; null for bun, which takes its folder
   * from `BUN_INSTALL`, and for a copy npm installed outside a global prefix, as into a project.
   */
  dir: string | null
}

/**
 * The global install `file`, a file of the npm package `npmPackage`, lies in, told by the folders
 * above the package: bun's `install/global`, yarn's `global` folder, pnpm's `global/<layout>`, or
 * else npm's prefix. Null when the file is not in the package.
 */
export function globalInstallOf(
  file: string,
  npmPackage: string,
  platform: Platform,
): GlobalInstall | null {
  const windows = platform === 'win32'
  const slashed = windows ? file.replaceAll('\\', '/') : file
  const folded = windows ? slashed.toLowerCase() : slashed
  const marker = `/node_modules/${windows ? npmPackage.toLowerCase() : npmPackage}/`
  const at = folded.lastIndexOf(marker)
  if (at <= 0) return null
  const above = folded.slice(0, at)
  // The original spelling, with the platform's own separators.
  const original = (end: number): string => file.slice(0, end)
  if (above.endsWith('/install/global')) return { manager: 'bun', dir: null }
  // `~/.config/yarn/global`, or `%LOCALAPPDATA%\Yarn\Data\global` on Windows.
  if (/\/yarn(?:\/data)?\/global$/i.test(above)) return { manager: 'yarn', dir: original(at) }
  // npm keeps global packages in `<prefix>/lib/node_modules` off Windows.
  if (!windows && above.endsWith('/lib')) return { manager: 'npm', dir: original(at - 4) }
  // pnpm keeps them under `<global-dir>/5` until pnpm 10 and `<global-dir>/v11` since.
  const pnpm = /^(.*\/global)\/(?:5|v\d+)(?:\/|$)/.exec(above)
  if (pnpm?.[1]) return { manager: 'pnpm', dir: original(pnpm[1].length) }
  return { manager: 'npm', dir: windows ? npmPrefixOf(file, npmPackage, platform) : null }
}

/**
 * The file a shell shim starts, as pnpm writes one for each global command: the last path it
 * quotes after `$basedir/`, other than Node.js itself, taken from the shim's folder. Null for any
 * other file.
 */
export function shellShimTarget(text: string, shim: string): string | null {
  if (!text.startsWith('#!/bin/sh')) return null
  const quoted = [...text.matchAll(/"\$basedir\/([^"$]+)"/g)].map((match) => match[1] ?? '')
  const target = quoted.filter((file) => path.posix.basename(file) !== 'node').at(-1)
  return target ? path.posix.resolve(path.posix.dirname(shim), target) : null
}

/**
 * The npm prefix a global package's file was installed under: the folder above its
 * `lib/node_modules`, or its `node_modules` on Windows. Null when the file is not in the package.
 */
export function npmPrefixOf(
  realPath: string,
  npmPackage: string,
  platform: Platform,
): string | null {
  const p = platformPath(platform)
  const windows = platform === 'win32'
  const file = windows ? realPath.replaceAll('/', '\\') : realPath
  const parts = [...(windows ? [] : ['lib']), 'node_modules', ...npmPackage.split('/')]
  const marker = `${p.sep}${parts.join(p.sep)}${p.sep}`
  const at = windows
    ? file.toLowerCase().lastIndexOf(marker.toLowerCase())
    : file.lastIndexOf(marker)
  return at > 0 ? file.slice(0, at) : null
}

/** How a program is updated: the command shown, and what runs it, or null while its tool is missing. */
export interface UpdatePlan {
  command: string
  run: { program: string; args: string[] } | null
}

/**
 * The update for the way the program was installed: its own update command or the install script
 * again, `brew upgrade`, `winget upgrade`, or the package manager's global install at the latest
 * version.
 */
export async function updatePlan(
  installs: BinaryInstalls,
  method: ProgramMethod,
  ctx: Pick<PlanContext, 'platform' | 'env' | 'npm' | 'isExecutable'> & {
    program: string
    /** The npm prefix the program was installed under, which may not be the PATH npm's own. */
    npmPrefix?: string | null
    /** pnpm's global dir or yarn's global folder the program was installed under. */
    globalDir?: string | null
    /** The version a package manager installs; its newest when not given. */
    version?: string
  },
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
      const plan = scriptPlan(
        installs.script,
        shellName,
        shell,
        curl,
        platform,
        installs.scriptArgs,
      )
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
      const args = [
        'install',
        '-g',
        ...(ctx.npmPrefix ? ['--prefix', ctx.npmPrefix] : []),
        ...(installs.ignoreScripts ? ['--ignore-scripts'] : []),
        npmSpec(installs, ctx.version ?? installs.npmTag ?? 'latest'),
      ]
      return {
        command: formatCommand({ command: 'npm', args }, platform),
        run: ctx.npm ? { program: ctx.npm, args: [...args, ...NPM_GLOBAL_FLAGS] } : null,
      }
    }
    case 'pnpm':
    case 'bun':
    case 'yarn': {
      if (!installs.npm) return null
      const args = [
        ...GLOBAL_ADD[method],
        ...(ctx.globalDir && method !== 'bun' ? [DIR_FLAG[method], ctx.globalDir] : []),
        ...(installs.ignoreScripts ? ['--ignore-scripts'] : []),
        npmSpec(installs, ctx.version ?? installs.npmTag ?? 'latest'),
      ]
      const tool = await findCommand(method, ctx)
      return {
        command: formatCommand({ command: method, args }, platform),
        run: tool ? { program: tool, args } : null,
      }
    }
    case 'archive':
      return null
  }
}

/** How pnpm, bun and yarn add and remove a global package. */
const GLOBAL_ADD = { pnpm: ['add', '-g'], bun: ['add', '-g'], yarn: ['global', 'add'] } as const
const GLOBAL_REMOVE = {
  npm: ['uninstall', '-g'],
  pnpm: ['remove', '-g'],
  bun: ['remove', '-g'],
  yarn: ['global', 'remove'],
} as const
/** The flag that names the folder a global install is in; bun has none. */
const DIR_FLAG = { npm: '--prefix', pnpm: '--global-dir', yarn: '--global-folder' } as const

/**
 * What removes a global package, with the tool that installed it, from the folder it was found
 * in; `tool` is the tool's name, looked up when it runs. Null for npm without its prefix, since
 * the PATH npm's own prefix may hold another copy.
 */
export function uninstallPlan(
  manager: PackageManager,
  npmPackage: string,
  dir: string | null,
  platform: Platform,
): { command: string; tool: PackageManager; args: string[] } | null {
  if (manager === 'npm' && !dir) return null
  const args = [
    ...GLOBAL_REMOVE[manager],
    ...(dir && manager !== 'bun' ? [DIR_FLAG[manager], dir] : []),
    npmPackage,
  ]
  return { command: formatCommand({ command: manager, args }, platform), tool: manager, args }
}
