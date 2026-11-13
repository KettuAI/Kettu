import type { MemoryScope } from '@shared/memory'
import { openHostSettingsItem } from './host-sections'

/** An entry's page in Settings › Memory: its layer, a project's path as its host writes it. */
export interface MemoryItem {
  scope: MemoryScope
  id: string
}

/** The item a memory entry's page goes by: `g/<id>`, or `p/<id>/<project>` with the path encoded. */
export function memoryItemKey(scope: MemoryScope, id: string): string {
  return scope.layer === 'global' ? `g/${id}` : `p/${id}/${encodeURIComponent(scope.project)}`
}

export function parseMemoryItem(key: string): MemoryItem | null {
  const [layer, id, project, ...rest] = key.split('/')
  if (!id || rest.length > 0) return null
  if (layer === 'g' && project === undefined) return { scope: { layer: 'global' }, id }
  if (layer !== 'p' || !project) return null
  try {
    return { scope: { layer: 'project', project: decodeURIComponent(project) }, id }
  } catch {
    return null
  }
}

/** Opens a memory entry's page in the Settings of the host that keeps it, null being this one. */
export function openMemoryItem(hostId: string | null, scope: MemoryScope, id: string): void {
  openHostSettingsItem(hostId, 'memory', memoryItemKey(scope, id))
}
