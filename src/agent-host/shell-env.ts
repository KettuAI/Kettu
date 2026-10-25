// The environment agents run in: the login shell's, resolved once the way VS Code does it,
// because apps started from the Dock or a desktop launcher get a minimal PATH.

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { EnvironmentInfo } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { ProxySettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { deleteEnv, findCommand, getEnv, isExecutableFile, type Env } from './find-command'
import { translate, type HostMessage } from './i18n'
import { quotePosix } from './quote'

export const SHELL_ENV_TIMEOUT_MS = 10_000
const MAX_PROBE_OUTPUT = 8 * 1024 * 1024

export function defaultShell(platform: Platform, env: Env): string {
  const shell = env.SHELL
  if (shell && path.posix.isAbsolute(shell)) return shell
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

/**
 * Arguments that make `shell` print the environment between two markers. csh and tcsh
 * accept `-l` only as their sole flag, so they run interactive without it (`-ic`), as in
 * VS Code; pwsh and nu need their own syntax.
 */
export function shellProbeArgs(shell: string, electronPath: string, mark: string): string[] {
  const name = path.posix.basename(shell).replace(/\.exe$/i, '')
  const exe = quotePosix(electronPath)
  if (/^(?:pwsh|powershell)(?:-preview)?$/.test(name)) {
    const ps = `'${electronPath.replace(/'/g, "''")}'`
    return [
      '-Login',
      '-Command',
      `& ${ps} -p '''${mark}'' + JSON.stringify(process.env) + ''${mark}'''`,
    ]
  }
  const command = `${name === 'nu' ? '^' : ''}${exe} -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`
  if (name === 'tcsh' || name === 'csh') return ['-ic', command]
  return ['-i', '-l', '-c', command]
}

/** The environment printed between the markers, or null when the output has none. */
export function parseProbeOutput(stdout: string, mark: string): Env | null {
  const start = stdout.indexOf(mark)
  if (start < 0) return null
  const end = stdout.indexOf(mark, start + mark.length)
  if (end < 0) return null
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start + mark.length, end))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const env: Env = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') env[key] = value
    }
    return env
  } catch {
    return null
  }
}

/** Removes Electron's variables, which would make an agent's Node.js behave like Electron. */
export function withoutElectronVars(env: Env, platform: Platform): Env {
  const out: Env = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = platform === 'win32' ? key.toUpperCase() : key
    if (upper.startsWith('ELECTRON_') || value === undefined) continue
    out[key] = value
  }
  return out
}

const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const

/**
 * A custom proxy replaces the proxy variables in both cases; on Windows, where names are
 * case-insensitive, only the upper-case forms are set so the two cannot disagree.
 */
export function applyProxy(env: Env, proxy: ProxySettings, platform: Platform): Env {
  if (proxy.mode !== 'custom') return env
  const out = { ...env }
  for (const name of PROXY_NAMES) {
    deleteEnv(out, name, platform)
    deleteEnv(out, name.toLowerCase(), platform)
  }
  const values: [string, string][] = [
    ['HTTP_PROXY', proxy.url],
    ['HTTPS_PROXY', proxy.url],
  ]
  if (proxy.noProxy.trim() !== '') values.push(['NO_PROXY', proxy.noProxy.trim()])
  for (const [name, value] of values) {
    out[name] = value
    if (platform !== 'win32') out[name.toLowerCase()] = value
  }
  return out
}

/** An agent's own configuration folder, which wins over the same variable from the shell. */
export function applyConfigFolder(
  env: Env,
  folder: ConfigFolder | undefined,
  platform: Platform,
): Env {
  if (!folder) return env
  const out = { ...env }
  deleteEnv(out, folder.variable, platform)
  out[folder.variable] = folder.path
  return out
}

/** The variable that moves an agent's configuration folder, and the folder picked for it. */
export interface ConfigFolder {
  variable: string
  path: string
}

export interface ShellEnvironment {
  env: Env
  source: EnvironmentInfo['source']
  shell: string | null
  durationMs: number
  // Kept as a message so Settings shows it in the language chosen later.
  warning: HostMessage | null
}

export interface ResolveOptions {
  platform: Platform
  electronPath: string
  baseEnv: Env
  timeoutMs?: number
}

function runProbe(shell: string, options: ResolveOptions, timeoutMs: number): Promise<Env> {
  const mark = randomBytes(8).toString('hex')
  const args = shellProbeArgs(shell, options.electronPath, mark)
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      // No controlling terminal, so an interactive profile cannot stop the probe for input.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...options.baseEnv, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, env?: Env): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(env!)
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      finish(new Error(`the login shell did not answer within ${timeoutMs / 1000} s`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += data
    })
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      if (stderr.length < 64 * 1024) stderr += data
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      const env = parseProbeOutput(stdout, mark)
      if (env) return finish(null, env)
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      const detail = stderr.trim().split('\n').slice(-3).join(' ')
      finish(
        new Error(
          `${path.posix.basename(shell)} printed no environment (${reason})${detail ? `: ${detail}` : ''}`,
        ),
      )
    })
  })
}

/**
 * The login shell's environment on macOS and Linux, and the inherited one on Windows. On
 * timeout or failure the inherited environment is used, with a warning for Settings.
 */
export async function resolveShellEnvironment(options: ResolveOptions): Promise<ShellEnvironment> {
  const started = Date.now()
  const { platform, baseEnv } = options
  if (platform === 'win32') {
    return {
      env: withoutElectronVars(baseEnv, platform),
      source: 'inherited',
      shell: null,
      durationMs: 0,
      warning: { key: 'environment.inherited' },
    }
  }
  const shell = defaultShell(platform, baseEnv)
  try {
    const env = await runProbe(shell, options, options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS)
    return {
      env: withoutElectronVars(env, platform),
      source: 'login-shell',
      shell,
      durationMs: Date.now() - started,
      warning: null,
    }
  } catch (error) {
    return {
      env: withoutElectronVars(baseEnv, platform),
      source: 'fallback',
      shell,
      durationMs: Date.now() - started,
      warning: {
        key: 'environment.fallback',
        params: { shell, error: (error as Error).message },
      },
    }
  }
}

export interface NodeProbe {
  nodeVersion: string | null
  npmPath: string | null
  nodePath: string | null
}

/** Finds `node` and `npm` and asks `node --version`, with the agent environment. */
export async function probeNode(env: Env, platform: Platform): Promise<NodeProbe> {
  const lookup = { platform, env, isExecutable: (file: string) => isExecutableFile(file, platform) }
  const [nodePath, npmPath] = await Promise.all([
    findCommand('node', lookup),
    findCommand('npm', lookup),
  ])
  if (!nodePath) return { nodeVersion: null, npmPath, nodePath }
  const nodeVersion = await new Promise<string | null>((resolve) => {
    execFile(
      nodePath,
      ['--version'],
      { env: env as NodeJS.ProcessEnv, timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
  })
  return { nodeVersion, npmPath, nodePath }
}

/** Whether a `v24.1.0`-style version satisfies a `>=22`-style requirement. */
export function satisfiesNode(version: string, requirement: string): boolean {
  const have = /^v?(\d+)(?:\.(\d+))?/.exec(version.trim())
  const need = /^>=\s*(\d+)(?:\.(\d+))?/.exec(requirement.trim())
  if (!have || !need) return false
  const [haveMajor, haveMinor] = [Number(have[1]), Number(have[2] ?? 0)]
  const [needMajor, needMinor] = [Number(need[1]), Number(need[2] ?? 0)]
  return haveMajor > needMajor || (haveMajor === needMajor && haveMinor >= needMinor)
}

export interface EnvironmentServiceDeps {
  platform: Platform
  electronPath: string
  baseEnv: Env
  resolve?: (options: ResolveOptions) => Promise<ShellEnvironment>
  probe?: (env: Env, platform: Platform) => Promise<NodeProbe>
}

/**
 * Resolves the environment once, in the background, and caches it for the life of the
 * host. Agents wait for it; `reload` resolves it again.
 */
export class EnvironmentService {
  private resolved: ShellEnvironment | null = null
  private node: NodeProbe = { nodeVersion: null, npmPath: null, nodePath: null }
  private current: Promise<void> | null = null
  private proxy: ProxySettings = { mode: 'environment' }
  private configFolders: Partial<Record<AgentId, ConfigFolder>> = {}
  private resolvedAt: number | null = null
  private listeners = new Set<(info: EnvironmentInfo) => void>()

  constructor(private readonly deps: EnvironmentServiceDeps) {}

  /** Starts resolving if nothing has yet; returns when the environment is known. */
  ready(): Promise<void> {
    this.current ??= this.run()
    return this.current
  }

  reload(): Promise<void> {
    this.current = this.run()
    return this.current
  }

  private async run(): Promise<void> {
    const resolve = this.deps.resolve ?? resolveShellEnvironment
    this.resolved = await resolve({
      platform: this.deps.platform,
      electronPath: this.deps.electronPath,
      baseEnv: this.deps.baseEnv,
    })
    this.node = await (this.deps.probe ?? probeNode)(this.resolved.env, this.deps.platform)
    this.resolvedAt = Date.now()
    const info = this.info()
    for (const listener of this.listeners) listener(info)
  }

  setProxy(proxy: ProxySettings): void {
    this.proxy = proxy
  }

  setConfigFolders(folders: Partial<Record<AgentId, ConfigFolder>>): void {
    this.configFolders = folders
  }

  /**
   * The environment for agents and git: resolved, without Electron's variables, with the proxy.
   * An agent's own adds its configuration folder; git, commands and the terminal go without one.
   */
  agentEnv(agentId?: AgentId): Env {
    const { platform } = this.deps
    const base = this.resolved?.env ?? withoutElectronVars(this.deps.baseEnv, platform)
    const env = applyProxy(base, this.proxy, platform)
    return agentId ? applyConfigFolder(env, this.configFolders[agentId], platform) : env
  }

  nodeProbe(): NodeProbe {
    return this.node
  }

  info(): EnvironmentInfo {
    const resolved = this.resolved
    return {
      source: resolved?.source ?? 'pending',
      shell: resolved?.shell ?? null,
      resolvedAt: this.resolvedAt,
      durationMs: resolved?.durationMs ?? null,
      warning: resolved?.warning ? translate(resolved.warning) : null,
      nodeVersion: this.node.nodeVersion,
      npmPath: this.node.npmPath,
    }
  }

  get(name: string, agentId?: AgentId): string | undefined {
    return getEnv(this.agentEnv(agentId), name, this.deps.platform)
  }

  onChange(listener: (info: EnvironmentInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
