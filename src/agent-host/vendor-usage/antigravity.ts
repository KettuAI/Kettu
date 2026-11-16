// Google Antigravity's plan and plan limits.
//
// The plan: agy's ACP mode names it in the `_meta` of its answers to `authenticate`,
// `session/new`, `session/load` and `session/resume` when signed in with Google, and declares
// `_meta.antigravity.tier` in `initialize`:
// `{ antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri } } }`.
//
// The limits: agy has no `/usage` command, so it would send one to the model. The registry's ACP
// server, `agy_acp_server`, answers `/usage` itself, without a model request, with the quota
// groups of the signed-in account (1.5.0):
//
//   ### Quota Limits
//   - **Gemini Models**
//     *(Models within this group: Gemini 3.8 Flash)*
//     - **Weekly Limit Remaining:** 99% remaining (resets Nov 23, 2026, 17:37 UTC)
//     - **Five Hour Limit Remaining:** 99% remaining (resets Nov 16, 2026, 22:37 UTC)

import path from 'node:path'
import type { PlanLimit } from '@shared/agent-host'
import type { ArchiveRelease } from '../binary-install'
import { object, percentLimit, type VendorUsage } from './common'

/** The version the plan was checked on, as agy names it in `initialize`; later ones keep it. */
export const ANTIGRAVITY_TIER_VERSION = '1.5.9'

/** The plan's name in an answer's `_meta`, or null when it names none. */
export function antigravityTier(meta: unknown): string | null {
  const tier = object(object(object(meta)?.antigravity)?.tier)
  const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
  return name || null
}

/** The registry's ACP server, run only to answer `/usage`; its Linux builds take an empty `--uid`. */
export const ANTIGRAVITY_USAGE_SERVER: ArchiveRelease = {
  version: '1.5.0',
  entries: {
    'darwin-aarch64': {
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-arm64.zip',
      sha256: 'c82ecb4ef476bfc35cbe5b2745cdddef873b99c9f5bd7fd11e5ca1fc1667a3fc',
      cmd: './agy_acp_server.par',
    },
    'darwin-x86_64': {
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-x86_64.zip',
      sha256: '86a94e33b25d4a38ff30526ad844546860aa9ed98698498d9e87d30eb794426e',
      cmd: './agy_acp_server.par',
    },
    'linux-x86_64': {
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.0-linux-x86_64.zip',
      sha256: '36f373e8948edf1727b39c7d62b5722d6a4474bdfd72b04ad3d6def571808c9f',
      cmd: './agy_acp_server.par',
      args: ['--uid='],
    },
    'linux-aarch64': {
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.0-linux-arm64.zip',
      sha256: '1e184f439477b54138e94440056b26a78c0a8075a8fd2ffda637ec31267c6459',
      cmd: './agy_acp_server.par',
      args: ['--uid='],
    },
    'windows-x86_64': {
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.0-windows-x86_64.zip',
      sha256: '6163f6b59b381bae419652dbae167bc8cda0ef29d665c0ba8af3d8c7fddd8867',
      cmd: './agy_acp_server.exe',
    },
    'windows-aarch64': {
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.0-windows-arm64.zip',
      sha256: '340092b8af6dafc71eb15f4a8ec54b4d1f0bce16d1fa4d163b562c50b905f8f4',
      cmd: './agy_acp_server.exe',
    },
  },
}

/** The sign-ins whose plan limits the usage server reads: Google and Gemini Enterprise. */
export const ANTIGRAVITY_PLAN_SIGN_INS: readonly string[] = ['oauth-personal', 'oauth-business']

/** Where agy 1.5.9 keeps the sign-in method its ACP mode uses, under the home folder. */
export function antigravityAuthStateFile(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json')
}

/**
 * The sign-in method agy last used, from the `methodId` of its
 * `~/.gemini/antigravity-cli/cache/acp-auth-state.json` (1.5.9); null when the file names none.
 * Only that field is read: the file holds no credential, and nothing else of it is kept.
 */
export function antigravitySignInMethod(text: string): string | null {
  try {
    const method = object(JSON.parse(text))?.methodId
    return typeof method === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(method) ? method : null
  } catch {
    return null
  }
}

const WINDOWS: Readonly<Record<string, { window: string; label: string }>> = {
  'five hour': { window: 'five_hour', label: '5-hour' },
  weekly: { window: 'seven_day', label: 'Weekly' },
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** `Nov 23, 2026, 17:37 UTC`, the server's `%b %d, %Y, %H:%M UTC`, as milliseconds. */
function resetTime(text: string): number | null {
  const match = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) UTC$/.exec(text.trim())
  if (!match) return null
  const month = MONTHS.indexOf(match[1]!.toLowerCase())
  if (month < 0) return null
  const at = Date.UTC(Number(match[3]), month, Number(match[2]), Number(match[4]), Number(match[5]))
  return Number.isFinite(at) ? at : null
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('_')

/**
 * The quota groups' windows in the server's `/usage` reply, each window per group as
 * `five_hour_<group>` or `seven_day_<group>` with the group's models; null for a message that is
 * not that reply, or one that says the quota could not be read. A group reported with no window
 * Kettu knows gives none.
 */
export function parseAntigravityUsage(markdown: string, now: number): VendorUsage | null {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => /^#+\s*Quota Limits\s*$/i.test(line.trim()))
  if (start < 0) return null
  const limits: PlanLimit[] = []
  let group: { name: string; models: string[] } | null = null
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trimEnd()
    if (/^#+\s/.test(line.trim())) break
    if (/^-\s+(Unable to retrieve|Not applicable)/i.test(line.trim())) return null
    const named = /^-\s+\*\*(.+?)\*\*\s*$/.exec(line)
    if (named) {
      group = { name: named[1]!.trim(), models: [] }
      continue
    }
    if (!group) continue
    const models = /^\s+\*\(Models within this group:\s*(.+?)\)\*\s*$/.exec(line)
    if (models) {
      group.models = models[1]!
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
      continue
    }
    const value = /^\s+-\s+\*\*(.+?) Limit Remaining:\*\*\s*(.+)$/i.exec(line)
    if (!value) continue
    const kind = WINDOWS[value[1]!.trim().toLowerCase()]
    const remaining = /^(\d+(?:\.\d+)?)% remaining(?:\s*\(resets (.+)\))?$/i.exec(value[2]!.trim())
    if (!kind || !remaining) continue
    const left = Math.max(0, Math.min(100, Number(remaining[1])))
    const limit = percentLimit(
      `${kind.window}_${slug(group.name)}`,
      `${kind.label} · ${group.name}`,
      100 - left,
      now,
      remaining[2] ? resetTime(remaining[2]) : null,
    )
    limits.push(group.models.length > 0 ? { ...limit, models: [...group.models] } : limit)
  }
  return { limits, balances: [] }
}

const PROXY_FIELDS = [
  ['HTTPS', 'HTTPS_PROXY'],
  ['HTTP', 'HTTP_PROXY'],
] as const

/**
 * The macOS system proxy, from what `scutil --proxy` prints, as the variables a program that
 * reads no system settings takes: each of the HTTP and HTTPS proxies that is on. A SOCKS proxy
 * alone gives none.
 */
export function systemProxyEnv(scutil: string): Record<string, string> {
  const fields = new Map<string, string>()
  for (const line of scutil.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(\S+)\s*$/.exec(line)
    if (match) fields.set(match[1]!, match[2]!)
  }
  const env: Record<string, string> = {}
  for (const [prefix, name] of PROXY_FIELDS) {
    const host = fields.get(`${prefix}Proxy`)
    const port = Number(fields.get(`${prefix}Port`))
    if (fields.get(`${prefix}Enable`) !== '1' || !host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
      continue
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    const url = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
    env[name] = url
    env[name.toLowerCase()] = url
  }
  // A program given one of them uses it for both kinds of request.
  if (env.HTTPS_PROXY && !env.HTTP_PROXY) {
    env.HTTP_PROXY = env.HTTPS_PROXY
    env.http_proxy = env.HTTPS_PROXY
  }
  if (env.HTTP_PROXY && !env.HTTPS_PROXY) {
    env.HTTPS_PROXY = env.HTTP_PROXY
    env.https_proxy = env.HTTP_PROXY
  }
  return env
}

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

/** Whether an environment names a proxy already, in either case. */
export function namesProxy(env: Record<string, string | undefined>): boolean {
  return Object.entries(env).some(
    ([name, value]) => PROXY_VARIABLES.includes(name.toUpperCase()) && !!value?.trim(),
  )
}
