import type { MemoryScope } from '@shared/memory'
import { openHostSettingsItem } from './host-sections'

/** An entry's page in Settings › Memory: its layer, a project's path as its host writes it. */
export interface MemoryItem {
  scope: MemoryScope
  id: string
}

/** The id of the page that adds an entry, which no entry's id can be. */
export const NEW_MEMORY = '+'

/** The item a memory entry's page goes by: `g/<id>`, `b/<id>/<botId>`, or `p/<id>/<project>`. */
export function memoryItemKey(scope: MemoryScope, id: string): string {
  if (scope.layer === 'global') return `g/${id}`
  if (scope.layer === 'bot') return `b/${id}/${encodeURIComponent(scope.botId)}`
  return `p/${id}/${encodeURIComponent(scope.project)}`
}

export function parseMemoryItem(key: string): MemoryItem | null {
  const [layer, id, target, ...rest] = key.split('/')
  if (!id || rest.length > 0) return null
  if (layer === 'g' && target === undefined) return { scope: { layer: 'global' }, id }
  if (layer === 'b' && target) {
    try {
      return { scope: { layer: 'bot', botId: decodeURIComponent(target) }, id }
    } catch {
      return null
    }
  }
  if (layer !== 'p' || !target) return null
  try {
    return { scope: { layer: 'project', project: decodeURIComponent(target) }, id }
  } catch {
    return null
  }
}

/** Opens a memory entry's page in the Settings of the host that keeps it, null being this one. */
export function openMemoryItem(hostId: string | null, scope: MemoryScope, id: string): void {
  openHostSettingsItem(hostId, 'memory', memoryItemKey(scope, id))
}
