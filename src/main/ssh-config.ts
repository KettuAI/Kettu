// The machines of the user's own SSH config, for Add host's SSH tab. Only `Host` and `Include`
// lines are read, as OpenSSH reads them; each alias is then resolved by the system's `ssh -G`, so
// the address, user, port and jump hosts are what `ssh <alias>` uses. Kettu never writes the
// config and never opens a key file.

import { execFile } from 'node:child_process'
import { glob, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  MAX_SSH_CONFIG_HOSTS,
  parseSshTarget,
  sameSshAddress,
  type KnownHost,
  type SshConfigHost,
  type SshConfigHosts,
} from '@shared/remote/hosts'

/** How deep `Include` may nest, as in OpenSSH. */
const MAX_DEPTH = 16

/** How many `ssh -G` run at once, so a long config cannot flood the process table. */
export const RESOLVE_CONCURRENCY = 4

/** How long one `ssh -G` may take. */
export const RESOLVE_TIMEOUT_MS = 5_000

/** Code hosts that take SSH logins for Git alone, which no daemon can run on. */
const GIT_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'gitee.com',
  'ssh.dev.azure.com',
])

export const isGitHost = (hostname: string): boolean => GIT_HOSTS.has(hostname.toLowerCase())

/**
 * A config line's keyword, lowercased, and its arguments, split as OpenSSH splits them: a space
 * or one `=` after the keyword, quotes and backslash escapes in the arguments, and a `#` that
 * starts an argument ending the line. Null for a blank line, a comment, or unbalanced quotes.
 */
export function configLine(line: string): { keyword: string; args: string[] } | null {
  const head = /^[ \t]*([^ \t\r\n="']+)[ \t]*(?:=[ \t]*)?/.exec(line)
  if (!head || head[1]!.startsWith('#')) return null
  const args: string[] = []
  const rest = line.slice(head[0].length).replace(/[ \t\r\n\f]+$/, '')
  let i = 0
  while (i < rest.length) {
    if (rest[i] === ' ' || rest[i] === '\t') {
      i++
      continue
    }
    if (rest[i] === '#') break
    let arg = ''
    let quote = ''
    for (; i < rest.length; i++) {
      const char = rest[i]!
      const next = rest[i + 1]
      if (char === '\\') {
        if (next === "'" || next === '"' || next === '\\' || (!quote && next === ' ')) {
          arg += next
          i++
        } else arg += char
      } else if (!quote && (char === ' ' || char === '\t')) break
      else if (!quote && (char === '"' || char === "'")) quote = char
      else if (quote && char === quote) quote = ''
      else arg += char
    }
    if (quote) return null
    args.push(arg)
  }
  return { keyword: head[1]!.toLowerCase(), args }
}

/** The alias a `Host` line gives: its first pattern with no wildcard, negation or class. */
export function hostAlias(patterns: string[]): string | null {
  return patterns.find((pattern) => pattern.length > 0 && !/[*?![]/.test(pattern)) ?? null
}

/** The `Host` aliases and `Include` arguments of one config file, in order. */
export function configEntries(
  text: string,
): ({ kind: 'host'; alias: string } | { kind: 'include'; paths: string[] })[] {
  const entries: ({ kind: 'host'; alias: string } | { kind: 'include'; paths: string[] })[] = []
  for (const line of text.split('\n')) {
    const parsed = configLine(line)
    if (!parsed || parsed.args.length === 0) continue
    if (parsed.keyword === 'host') {
      const alias = hostAlias(parsed.args)
      if (alias !== null) entries.push({ kind: 'host', alias })
    } else if (parsed.keyword === 'include') {
      entries.push({ kind: 'include', paths: parsed.args })
    }
  }
  return entries
}

/** What reading the config gave: its aliases in order, or the file that could not be read. */
export type ConfigAliases = { aliases: string[] } | { failed: { path: string; detail: string } }

interface ReadOptions {
  home: string
  platform?: NodeJS.Platform
}

/** `~` and `~/` expanded, and a relative path taken from `~/.ssh`, as OpenSSH does. */
function includePath(arg: string, { home, platform = process.platform }: ReadOptions): string {
  const join = platform === 'win32' ? path.win32 : path.posix
  if (arg === '~') return home
  if (arg.startsWith('~/') || (platform === 'win32' && arg.startsWith('~\\'))) {
    return join.join(home, arg.slice(2))
  }
  // Another user's home, which only ssh can look up: it reads as missing.
  if (arg.startsWith('~')) return arg
  return join.isAbsolute(arg) ? arg : join.join(home, '.ssh', arg)
}

const hasGlob = (pattern: string): boolean => /[*?[]/.test(pattern)

async function matches(pattern: string, platform: NodeJS.Platform): Promise<string[]> {
  if (!hasGlob(pattern)) return [pattern]
  const found: string[] = []
  // Node's glob takes forward slashes, which Windows accepts too.
  for await (const entry of glob(platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern)) {
    found.push(entry)
  }
  // In the order glob(3) gives them.
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

/**
 * The aliases of the user's SSH config at `file`, following `Include`: each file read once, so
 * a loop ends, and a missing one skipped as ssh skips it.
 */
export async function readConfigAliases(
  file: string,
  options: ReadOptions,
): Promise<ConfigAliases> {
  const platform = options.platform ?? process.platform
  const aliases: string[] = []
  const seen = new Set<string>()
  const read = new Set<string>()
  const visit = async (
    at: string,
    depth: number,
  ): Promise<{ path: string; detail: string } | null> => {
    const key = path.resolve(at)
    if (read.has(key) || depth > MAX_DEPTH) return null
    read.add(key)
    let text: string
    try {
      text = await readFile(at, 'utf8')
    } catch (error) {
      // A folder an `Include` glob matched reads as empty, as for ssh.
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EISDIR') return null
      return { path: at, detail: error instanceof Error ? error.message : String(error) }
    }
    for (const entry of configEntries(text)) {
      if (entry.kind === 'host') {
        if (!seen.has(entry.alias)) {
          seen.add(entry.alias)
          aliases.push(entry.alias)
        }
        continue
      }
      for (const arg of entry.paths) {
        for (const match of await matches(includePath(arg, options), platform)) {
          const failed = await visit(match, depth + 1)
          if (failed) return failed
        }
      }
    }
    return null
  }
  const failed = await visit(file, 0)
  return failed ? { failed } : { aliases }
}

/** What `ssh -G` printed of a machine, or null when it names no host. */
export function parseResolved(
  stdout: string,
): Pick<SshConfigHost, 'user' | 'hostname' | 'port' | 'proxyJump'> | null {
  const fields = new Map<string, string>()
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    if (!fields.has(key)) fields.set(key, line.slice(space + 1).trim())
  }
  const hostname = fields.get('hostname')
  const user = fields.get('user')
  const port = Number(fields.get('port') ?? '22')
  if (!hostname || !user || !Number.isSafeInteger(port) || port < 1 || port > 65535) return null
  const jump = fields.get('proxyjump')
  return { user, hostname, port, ...(jump && jump !== 'none' ? { proxyJump: jump } : {}) }
}

/** Runs `ssh -G` on an alias: what it printed, or why it gave nothing. */
export type Resolve = (alias: string) => Promise<{ stdout: string } | 'missing' | 'failed'>

/** The system's `ssh -G`, killed once it takes too long. */
export const systemResolve: Resolve = (alias) =>
  new Promise((resolve) => {
    execFile(
      'ssh',
      ['-G', '--', alias],
      { timeout: RESOLVE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (errorCode(error) === 'ENOENT') resolve('missing')
        else resolve(error ? 'failed' : { stdout })
      },
    )
  })

/**
 * The machines of the user's SSH config Add host lists: each alias ssh resolves, in the config's
 * order, at most `RESOLVE_CONCURRENCY` at once and `MAX_SSH_CONFIG_HOSTS` in all, the code hosts
 * left out, and each named with the known host already added at that alias.
 */
export async function listSshConfigHosts(options: {
  known: readonly KnownHost[]
  home?: string
  file?: string
  platform?: NodeJS.Platform
  resolve?: Resolve
}): Promise<SshConfigHosts> {
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const join = platform === 'win32' ? path.win32 : path.posix
  const file = options.file ?? join.join(home, '.ssh', 'config')
  const read = await readConfigAliases(file, { home, platform })
  if ('failed' in read) return { state: 'failed', reason: 'unreadable', ...read.failed }
  const aliases = read.aliases.filter((alias) => parseSshTarget(alias) === alias)
  const resolve = options.resolve ?? systemResolve
  const found: (SshConfigHost | null)[] = []
  let next = 0
  let kept = 0
  let missing = false
  const work = async (): Promise<void> => {
    while (next < aliases.length && kept < MAX_SSH_CONFIG_HOSTS && !missing) {
      const index = next++
      const alias = aliases[index]!
      const answer = await resolve(alias)
      if (answer === 'missing') missing = true
      const resolved = typeof answer === 'object' ? parseResolved(answer.stdout) : null
      if (!resolved || isGitHost(resolved.hostname)) continue
      found[index] = { alias, ...resolved }
      kept++
    }
  }
  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, work))
  if (missing) return { state: 'failed', reason: 'ssh_missing' }
  const hosts = found.filter((host) => host != null).slice(0, MAX_SSH_CONFIG_HOSTS)
  return {
    state: 'ok',
    hosts: hosts.map((host) => {
      const added = options.known.find(
        (known) => !known.removed && known.ssh && sameSshAddress(known.ssh, { target: host.alias }),
      )
      return added ? { ...host, hostId: added.id } : host
    }),
  }
}
