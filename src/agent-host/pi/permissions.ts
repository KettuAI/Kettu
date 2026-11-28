// Pi tool permission gate helpers: symlink canonicalization, gate payload validation,
// and authoritative PermissionRequest construction for Routines and workflow steps.

import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { PendingPermission, ToolEntry, ToolKind } from '@shared/thread'
import type { Shell } from '../command-safety'
import { t } from '../i18n'
import { resolvePiPath, toolFacts, writesFile } from './mapper'

export { resolvePiPath } from './mapper'

const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit'])
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['grep', 'find', 'ls'])
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])

export const PI_PERMISSION_ALLOW = 'allow-once'
export const PI_PERMISSION_REJECT = 'reject'

/** Decoded payload sent by Kettu's Pi extension over `ctx.ui.confirm(PERMISSION_TITLE, payload)`. */
export interface PiPermissionGatePayload {
  nonce: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  parentToolCallId: string | null
}

/** Authoritative facts and options for a Pi tool call evaluated by Kettu's permission rules. */
export interface PiPermissionRequestDetails {
  title: string
  toolKind: ToolKind
  locations: ToolEntry['locations']
  content: ToolEntry['content']
  rawInput?: string
  description?: string
  options: PendingPermission['options']
  shell?: Shell
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Resolves symlinks for `target`, falling back to the nearest existing ancestor when `target` does
 * not exist yet (for example a new file created by `write`). Returns `null` on symlink loops or
 * other unresolvable filesystem errors so callers fail closed.
 */
async function realpathWithMissingTail(target: string, platform: Platform): Promise<string | null> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const tail: string[] = []
  let current = pathApi.resolve(target)
  // Guard against malformed or cyclic parent chains.
  for (let depth = 0; depth < 256; depth++) {
    try {
      const resolved = await realpath(current)
      return tail.length > 0 ? pathApi.join(resolved, ...tail.reverse()) : resolved
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const parent = pathApi.dirname(current)
      if (parent === current) return null
      tail.push(pathApi.basename(current))
      current = parent
    }
  }
  return null
}

/**
 * Resolves symlinks on `target` relative to `cwd`:
 * - When `realTarget` stays inside `realpath(cwd)`, maps it back under `cwd` using the canonical
 *   relative path. That keeps macOS `/var -> /private/var` paths aligned with `projectPath` while
 *   still exposing symlinks pointing at `<cwd>/.git` so `.git` write protection catches them.
 * - When `realTarget` escapes `realpath(cwd)` (for example a symlink inside the project pointing to
 *   `/etc/passwd`), returns `realTarget` directly so `withinScope` rejects it.
 * - Returns `null` on unresolvable errors (`ELOOP`, etc.) so callers fail closed.
 */
export async function resolveCanonicalPiPath(
  target: string,
  cwd: string,
  platform: Platform = process.platform as Platform,
): Promise<string | null> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const [realTarget, realCwd] = await Promise.all([
    realpathWithMissingTail(target, platform),
    realpath(cwd).catch(() => pathApi.resolve(cwd)),
  ])
  if (realTarget === null) return null
  const rel = pathApi.relative(realCwd, realTarget)
  const inside =
    rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel))
  if (!inside) return realTarget
  return rel === '' ? pathApi.resolve(cwd) : pathApi.join(pathApi.resolve(cwd), rel)
}

/** Parses and validates the JSON payload carried by a `__kettu_permission__` confirm request. */
export function parsePermissionGatePayload(
  raw: string | undefined,
): PiPermissionGatePayload | null {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (typeof o.nonce !== 'string' || o.nonce === '') return null
  if (typeof o.toolName !== 'string' || o.toolName === '') return null
  if (o.toolCallId !== undefined && typeof o.toolCallId !== 'string') return null
  if (
    o.parentToolCallId !== undefined &&
    o.parentToolCallId !== null &&
    typeof o.parentToolCallId !== 'string'
  ) {
    return null
  }
  return {
    nonce: o.nonce,
    toolCallId: typeof o.toolCallId === 'string' ? o.toolCallId : '',
    toolName: o.toolName,
    input: asRecord(o.input),
    parentToolCallId: typeof o.parentToolCallId === 'string' ? o.parentToolCallId : null,
  }
}

/**
 * Extracts raw path strings named by a Pi file tool (`read`, `write`, `edit`). If both `path` and
 * `file_path` are present, both are checked so neither can hide an out-of-scope target.
 * Returns `null` when a supplied path field is malformed or missing (fail-closed).
 */
function rawFileToolPaths(input: Record<string, unknown>): string[] | null {
  const paths: string[] = []
  if ('path' in input && input.path !== undefined) {
    if (typeof input.path !== 'string' || input.path === '') return null
    paths.push(input.path)
  }
  if ('file_path' in input && input.file_path !== undefined) {
    if (typeof input.file_path !== 'string' || input.file_path === '') return null
    if (!paths.includes(input.file_path)) paths.push(input.file_path)
  }
  return paths.length > 0 ? paths : null
}

/**
 * Extracts raw path strings named by a Pi search tool (`grep`, `find`, `ls`). When `path` is
 * omitted, Pi searches `cwd`; when provided, it must be a non-empty string.
 */
function rawSearchToolPaths(input: Record<string, unknown>, cwd: string): string[] | null {
  if (!('path' in input) || input.path === undefined) {
    if ('file_path' in input && input.file_path !== undefined) {
      if (typeof input.file_path !== 'string' || input.file_path === '') return null
      return [input.file_path]
    }
    return [cwd]
  }
  if (typeof input.path !== 'string' || input.path === '') return null
  return [input.path]
}

async function resolveLocations(
  rawPaths: readonly string[] | null,
  cwd: string,
  options: { homeDir?: string; platform?: Platform },
): Promise<ToolEntry['locations']> {
  if (!rawPaths || rawPaths.length === 0) return []
  const platform = options.platform ?? (process.platform as Platform)
  const resolved: ToolEntry['locations'] = []
  for (const raw of rawPaths) {
    const lexical = resolvePiPath(raw, cwd, options)
    if (!lexical) return []
    const canonical = await resolveCanonicalPiPath(lexical, cwd, platform)
    if (!canonical) return []
    resolved.push({ path: canonical })
  }
  return resolved
}

/**
 * Builds the authoritative `ToolEntry` facts, canonical `locations`, shell hint, and `allow_once` /
 * `reject_once` options for a Pi tool call intercepted by Kettu's permission gate.
 *
 * Security invariants:
 * - Only `allow_once` and `reject_once` are offered (never `allow_always`).
 * - File tools (`read`, `write`, `edit`) and search tools (`grep`, `find`, `ls`) always carry
 *   Pi-resolved, symlink-canonicalized `locations`, failing closed to `[]` if any path is invalid
 *   or unresolvable.
 * - `codemode` and any unknown or third-party MCP tool map to `toolKind: 'other'` so `withinScope`
 *   always requires explicit user approval regardless of scope level.
 */
export async function buildPiPermission(
  payload: Pick<PiPermissionGatePayload, 'toolName' | 'input'>,
  cwd: string,
  options: { homeDir?: string; platform?: Platform } = {},
): Promise<PiPermissionRequestDetails> {
  const { toolName, input } = payload
  const base = toolFacts(toolName, input, cwd)
  const permissionOptions: PendingPermission['options'] = [
    {
      id: PI_PERMISSION_ALLOW,
      name: t(writesFile(toolName) ? 'permission.allowEdit' : 'permission.allowOnce'),
      kind: 'allow_once',
    },
    {
      id: PI_PERMISSION_REJECT,
      name: t('permission.reject'),
      kind: 'reject_once',
    },
  ]

  if (FILE_TOOLS.has(toolName)) {
    const locations = await resolveLocations(rawFileToolPaths(input), cwd, options)
    const line =
      toolName === 'read' && typeof input.offset === 'number' && input.offset > 0
        ? input.offset
        : undefined
    return {
      ...base,
      toolKind: toolName === 'read' ? 'read' : 'edit',
      locations:
        line !== undefined && locations.length === 1
          ? [{ path: locations[0]!.path, line }]
          : locations,
      options: permissionOptions,
    }
  }

  if (SEARCH_TOOLS.has(toolName)) {
    const locations = await resolveLocations(rawSearchToolPaths(input, cwd), cwd, options)
    return {
      ...base,
      toolKind: 'search',
      locations,
      options: permissionOptions,
    }
  }

  if (SHELL_TOOLS.has(toolName)) {
    return {
      ...base,
      toolKind: 'execute',
      locations: [],
      options: permissionOptions,
      ...(toolName === 'powershell' ? { shell: 'powershell' as const } : {}),
    }
  }

  // Defense in depth: codemode (also omitted via --no-extensions), unknown tools, MCP resource
  // tools, and non-auto-allowed MCP tools always require explicit approval (`toolKind: 'other'`).
  return {
    ...base,
    toolKind: 'other',
    locations: [],
    options: permissionOptions,
  }
}
