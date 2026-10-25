// Whether a permission request is inside a routine's scope, by the platform's path rules.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { PermissionScope } from '@shared/routines'
import type { PermissionKind, ToolKind } from '@shared/thread'
import { isAbsolutePath, pathKey } from '../paths'

export interface ScopeRequest {
  toolKind: ToolKind
  /** Every path the request names, as the agent sent it. */
  locations: readonly string[]
  options: readonly { id: string; kind: PermissionKind }[]
}

// Fetch is in every level, gated by the web switch below.
const BASE_KINDS: readonly ToolKind[] = ['read', 'search', 'think', 'fetch']
const EDIT_KINDS: readonly ToolKind[] = [...BASE_KINDS, 'edit', 'delete', 'move']
const COMMAND_KINDS: readonly ToolKind[] = [...EDIT_KINDS, 'execute']

function allowedKinds(level: PermissionScope['level']): readonly ToolKind[] {
  return level === 'read' ? BASE_KINDS : level === 'edit' ? EDIT_KINDS : COMMAND_KINDS
}

/**
 * Whether the request is inside the scope: its kind at the level, every location it names in
 * the project and outside `.git`, and no location only for the kinds that name none.
 */
export function withinScope(
  scope: PermissionScope,
  projectPath: string,
  request: Pick<ScopeRequest, 'toolKind' | 'locations'>,
  platform: Platform,
): boolean {
  const { toolKind, locations } = request
  if (!allowedKinds(scope.level).includes(toolKind)) return false
  if (toolKind === 'fetch' && !scope.web) return false
  if (locations.length === 0) {
    return toolKind === 'think' || toolKind === 'fetch' || toolKind === 'execute'
  }
  const project = pathKey(projectPath, platform)
  const git = pathKey(`${projectPath}${separator(platform)}.git`, platform)
  const edit = toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move'
  return locations.every((location) => {
    const key = locationKey(projectPath, location, platform)
    if (!inside(key, project, platform)) return false
    return !edit || !inside(key, git, platform)
  })
}

/**
 * The `allow_once` option to answer with, or null to let the request wait. An `allow_always`
 * option is never picked: it would outlive the run in the agent's own settings.
 */
export function scopeAnswer(
  scope: PermissionScope,
  projectPath: string,
  request: ScopeRequest,
  platform: Platform,
): string | null {
  if (!withinScope(scope, projectPath, request, platform)) return null
  return request.options.find((option) => option.kind === 'allow_once')?.id ?? null
}

function separator(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/'
}

/** A location as a key; a relative one resolves against the project, the agent's folder. */
function locationKey(projectPath: string, location: string, platform: Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const absolute = isAbsolutePath(location, platform)
    ? p.normalize(location)
    : p.resolve(projectPath, location)
  return pathKey(absolute, platform)
}

function inside(key: string, root: string, platform: Platform): boolean {
  if (key === root) return true
  const sep = separator(platform)
  return key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}
