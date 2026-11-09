// The official MCP Registry's entries as the Marketplace lists them: each read into the spec Kettu
// would install, the server's remote first, else a package started with npx, uvx or Docker. An
// entry Kettu cannot run is left out, as is one that would need a value the user types on the
// command line, where other users of the computer could read it.

import { getDomain } from 'tldts'
import type { CatalogServer, McpSpec, McpValue } from '@shared/marketplace'

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1'

/** What the app's own lists add to an entry. */
export interface Listing {
  official?: boolean
  brand?: string
  /** Shown when the entry has no title of its own. */
  title?: string
  /** Text before an input's value, by input name, where the entry does not say, such as `Bearer `. */
  prefixes?: Record<string, string>
}

// The bounds main keeps a spec to when it is installed.
const REGISTRY_NAME = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/
const MAX_ID = 200
const MAX_TITLE = 200
const MAX_VERSION = 100
const MAX_TEXT = 4096
const MAX_ARGS = 200
const MAX_VALUES = 64
const MAX_VALUE_NAME = 128
const MAX_DESCRIPTION = 1000
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// One variable at the end of a value, with fixed text before it: `Bearer {token}`.
const ONE_VARIABLE = /^([^{}]*)\{([A-Za-z0-9_.-]+)\}$/
const VARIABLE = /\{([A-Za-z0-9_.-]+)\}/g
const NPM_REGISTRY = 'https://registry.npmjs.org'
const PYPI_REGISTRY = 'https://pypi.org'
const STATUS_KEY = 'io.modelcontextprotocol.registry/official'

type Fields = Record<string, unknown>

/** Thrown inside a package's reading when it cannot be run; the caller tries the next one. */
class Unrunnable extends Error {}

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function list(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** A value fit for one line of a spec. */
function line(value: string): string {
  if (value.length > MAX_TEXT || /[\r\n\0]/.test(value)) throw new Unrunnable()
  return value
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  const url = URL.parse(value)
  return url?.protocol === 'https:' ? value : null
}

function description(value: unknown): { description?: string } {
  const said = text(value)?.trim()
  return said ? { description: said.slice(0, MAX_DESCRIPTION) } : {}
}

interface Input {
  isSecret?: unknown
  isRequired?: unknown
  default?: unknown
  value?: unknown
  description?: unknown
}

/** The fixed text a variable stands for, from its own value or default; none for a secret. */
function fixedVariable(variable: Input | undefined): string | null {
  if (!variable || variable.isSecret === true) return null
  return text(variable.value) ?? text(variable.default) ?? null
}

/** A value with every variable filled from its fixed text; null when one has none. */
function substituted(value: string, variables: unknown): string | null {
  let missing = false
  const out = value.replace(VARIABLE, (_, name: string) => {
    const filled = fixedVariable(isRecord(variables) ? (variables[name] as Input) : undefined)
    if (filled === null) missing = true
    return filled ?? ''
  })
  return missing ? null : out
}

/**
 * A header or environment variable as a spec holds it: a fixed value, or an input the user fills
 * when installing, kept with the keys.
 */
function value(name: string, item: Fields, listing: Listing | undefined): McpValue | null {
  const given = text(item.value)
  const prefix = listing?.prefixes?.[name]
  const input = (from: Input, extra: { prefix?: string }): McpValue => ({
    name,
    input: true,
    secret: from.isSecret === true || item.isSecret === true,
    required: from.isRequired === true || item.isRequired === true,
    ...description(item.description ?? from.description),
    ...(extra.prefix ? { prefix: line(extra.prefix) } : {}),
  })
  if (given !== undefined) {
    if (!given.includes('{')) return { name, value: line(given) }
    const filled = substituted(given, item.variables)
    if (filled !== null) return { name, value: line(filled) }
    const one = ONE_VARIABLE.exec(given)
    if (!one) return null
    const variables = isRecord(item.variables) ? item.variables : {}
    const variable = (isRecord(variables[one[2]!]) ? variables[one[2]!] : {}) as Input
    return input(variable, { prefix: one[1] })
  }
  const fallback = text(item.default)
  if (item.isSecret !== true && fallback !== undefined) return { name, value: line(fallback) }
  return input({}, prefix ? { prefix } : {})
}

function values(items: Fields[], pattern: RegExp, listing: Listing | undefined): McpValue[] | null {
  const out: McpValue[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const name = text(item.name)
    if (!name || name.length > MAX_VALUE_NAME || !pattern.test(name) || seen.has(name)) return null
    seen.add(name)
    const read = value(name, item, listing)
    if (!read) return null
    out.push(read)
  }
  return out.length > MAX_VALUES ? null : out
}

function remoteSpec(remotes: Fields[], listing: Listing | undefined): McpSpec | null {
  // Streamable HTTP first: every agent that takes a URL speaks it, and Codex nothing else.
  for (const transport of ['streamable-http', 'sse'] as const) {
    for (const remote of remotes) {
      if (remote.type !== transport) continue
      const url = httpsUrl(remote.url)
      if (!url || url.includes('{')) continue
      try {
        const headers = values(list(remote.headers), HEADER_NAME, listing)
        if (headers) return withSignIn({ type: 'http', transport, url, headers })
      } catch (error) {
        if (!(error instanceof Unrunnable)) throw error
      }
    }
  }
  return null
}

// Remote servers whose service registers no clients: Kettu signs in with the device flow of an app
// it registered there, in place of the token header they ask for.
const DEVICE_HOSTS: ReadonlySet<string> = new Set(['api.githubcopilot.com'])

/**
 * A remote with no secret to type in signs in with OAuth, if it turns out to need any: GitHub's
 * through the device flow, without its token header, and every other through the browser.
 */
function withSignIn(spec: Extract<McpSpec, { type: 'http' }>): McpSpec {
  if (DEVICE_HOSTS.has(new URL(spec.url).hostname)) {
    const headers = spec.headers.filter(
      (header) => !('input' in header && header.name.toLowerCase() === 'authorization'),
    )
    return { ...spec, headers, oauth: { flow: 'device' } }
  }
  const secret = spec.headers.some((header) => 'input' in header && header.secret)
  return secret ? spec : { ...spec, oauth: { flow: 'browser' } }
}

/** A package's argument as words of the command line; empty when it is left out. */
function argument(arg: Fields): string[] {
  const name = text(arg.name)
  const given = text(arg.value) ?? text(arg.default)
  const filled = given === undefined ? undefined : substituted(given, arg.variables)
  // A value the user would have to type on the command line, where others could read it.
  if (filled === null) throw new Unrunnable()
  if (arg.type === 'positional') {
    if (filled === undefined) {
      if (arg.isRequired === true) throw new Unrunnable()
      return []
    }
    return [line(filled)]
  }
  if (arg.type !== 'named' || !name || !name.startsWith('-')) throw new Unrunnable()
  if (filled !== undefined) return [line(name), line(filled)]
  if (arg.isRequired !== true) return []
  // A required flag that takes no value.
  if (arg.format === 'boolean' || (arg.format === undefined && arg.valueHint === undefined)) {
    return [line(name)]
  }
  throw new Unrunnable()
}

/**
 * Docker's `-e NAME={var}`: the variable becomes an input of the server's environment, which
 * `docker run` passes on by name, so its value stays off the command line.
 */
function dockerEnv(arg: Fields, listing: Listing | undefined): McpValue | null {
  if (arg.type !== 'named' || (arg.name !== '-e' && arg.name !== '--env')) return null
  const given = text(arg.value)
  const match = given ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(given) : null
  if (!match || !match[2]!.includes('{')) return null
  if (substituted(match[2]!, arg.variables) !== null) return null
  const read = value(match[1]!, { ...arg, value: match[2] }, listing)
  if (!read) throw new Unrunnable()
  return read
}

function packageSpec(pkg: Fields, listing: Listing | undefined): McpSpec | null {
  if (!isRecord(pkg.transport) || pkg.transport.type !== 'stdio') return null
  const identifier = text(pkg.identifier)
  if (!identifier || /\s/.test(identifier) || identifier.startsWith('-')) return null
  const version = text(pkg.version)
  const base = text(pkg.registryBaseUrl)?.replace(/\/+$/, '')
  const kind = pkg.registryType
  try {
    const env = values(list(pkg.environmentVariables), ENV_NAME, listing)
    if (!env) return null
    const runtime: string[] = []
    for (const arg of list(pkg.runtimeArguments)) {
      const passed = kind === 'oci' ? dockerEnv(arg, listing) : null
      if (passed) {
        if (!env.some((v) => v.name === passed.name)) env.push(passed)
        continue
      }
      runtime.push(...argument(arg))
    }
    const args = list(pkg.packageArguments).flatMap(argument)
    if (env.length > MAX_VALUES) return null
    let spec: McpSpec
    if (kind === 'npm') {
      if ((base && base !== NPM_REGISTRY) || !version || /\s/.test(version)) return null
      spec = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', ...runtime, `${identifier}@${version}`, ...args],
        env,
      }
    } else if (kind === 'pypi') {
      if ((base && base !== PYPI_REGISTRY) || !version || /\s/.test(version)) return null
      spec = {
        type: 'stdio',
        command: 'uvx',
        args: [...runtime, `${identifier}==${version}`, ...args],
        env,
      }
    } else if (kind === 'oci') {
      const tagged =
        /[:@][^/]*$/.test(identifier) || !version ? identifier : `${identifier}:${version}`
      const passed = env.flatMap((v) => ['-e', v.name])
      spec = {
        type: 'stdio',
        command: 'docker',
        args: ['run', '-i', '--rm', ...runtime, ...passed, tagged, ...args],
        env,
      }
    } else {
      return null
    }
    if (spec.args.length > MAX_ARGS || spec.args.some((arg) => arg.length > MAX_TEXT)) return null
    return spec
  } catch (error) {
    if (error instanceof Unrunnable) return null
    throw error
  }
}

/** Who published a server: its repository's owner, else the domain its name reverses. */
function publisher(name: string, repository: string | null): string {
  const github = /^io\.github\.([^/]+)\//.exec(name)
  if (github) return github[1]!
  const owner = repository ? /^https:\/\/(?:github|gitlab)\.com\/([^/]+)\//.exec(repository) : null
  if (owner) return owner[1]!
  const domain = name.split('/')[0]!.split('.').reverse().join('.')
  return getDomain(domain) ?? domain
}

/**
 * One of the registry's `servers` items as the catalog lists it, or null when it is withdrawn,
 * malformed, or Kettu cannot run it.
 */
export function catalogServer(entry: unknown, listing?: Listing): CatalogServer | null {
  if (!isRecord(entry) || !isRecord(entry.server)) return null
  const server = entry.server
  const name = text(server.name)
  const version = text(server.version)
  if (!name || name.length > MAX_ID || !REGISTRY_NAME.test(name)) return null
  if (!version || version.length > MAX_VERSION) return null
  const meta =
    isRecord(entry._meta) && isRecord(entry._meta[STATUS_KEY]) ? entry._meta[STATUS_KEY] : {}
  if (meta.status !== undefined && meta.status !== 'active') return null
  let spec = remoteSpec(list(server.remotes), listing)
  for (const pkg of list(server.packages)) {
    if (spec) break
    spec = packageSpec(pkg, listing)
  }
  if (!spec) return null
  const repository = isRecord(server.repository) ? httpsUrl(server.repository.url) : null
  const own = text(server.title)?.trim()
  const title = (own || listing?.title || name.split('/')[1]!).slice(0, MAX_TITLE)
  const updated = text(meta.updatedAt)
  return {
    id: name,
    title,
    publisher: publisher(name, repository),
    official: listing?.official === true,
    description: text(server.description)?.trim() ?? '',
    version,
    updated: updated && !Number.isNaN(Date.parse(updated)) ? updated : null,
    repository,
    website: httpsUrl(server.websiteUrl),
    brand: listing?.brand ?? null,
    spec,
  }
}
