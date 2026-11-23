import { create } from 'zustand'
import type { ParamValue } from '@shared/artifact-params'
import type { DeckKept } from '@shared/artifact-runtime/deck-sheet'
import type { DocKept } from '@shared/artifact-runtime/document-sheet'

/**
 * A change the user made in an artifact's viewer that did not save, as its editor needs it to show
 * the change again and try once more.
 */
export type UnsavedChange =
  | {
      kind: 'element'
      /** The canvas page the element is on, or null for a single page. */
      page: number | null
      path: string
      /** Where the element's start tag lies in its file. */
      src: number
      /** The fields that differ from what the version holds, as typed. */
      fields: Readonly<Record<string, string | null>>
      /** The version the change was made on. */
      version: number
      error: string
    }
  | {
      kind: 'params'
      /** The frame's id. */
      frame: string
      /** The settings changed and not written. */
      values: Readonly<Record<string, ParamValue>>
      version: number
      error: string
    }
  | { kind: 'document'; kept: DocKept }
  | { kind: 'slides'; kept: readonly DeckKept[] }

/** Where a change lies in its artifact; one change is kept for each. */
export function unsavedSlot(
  change:
    | Pick<Extract<UnsavedChange, { kind: 'element' }>, 'kind' | 'page' | 'path' | 'src'>
    | Pick<Extract<UnsavedChange, { kind: 'params' }>, 'kind' | 'frame'>
    | { kind: 'document' | 'slides' },
): string {
  switch (change.kind) {
    case 'element':
      return `element:${change.page}:${change.path}:${change.src}`
    case 'params':
      return `params:${change.frame}`
    default:
      return change.kind
  }
}

interface ArtifactUnsavedStore {
  /** By artifact, then by slot. Kept in memory only: it is gone when the window closes. */
  byId: Record<string, Record<string, UnsavedChange>>
}

export const useArtifactUnsavedStore = create<ArtifactUnsavedStore>()(() => ({ byId: {} }))

export function keepUnsaved(id: string, change: UnsavedChange): void {
  useArtifactUnsavedStore.setState((s) => ({
    byId: { ...s.byId, [id]: { ...s.byId[id], [unsavedSlot(change)]: change } },
  }))
}

/** Forgets the change at `slot`, saved or discarded; without one, every change of the artifact. */
export function dropUnsaved(id: string, slot?: string): void {
  useArtifactUnsavedStore.setState((s) => {
    const was = s.byId[id]
    if (!was || (slot !== undefined && !(slot in was))) return s
    const byId = { ...s.byId }
    const left = { ...was }
    if (slot !== undefined) delete left[slot]
    if (slot === undefined || Object.keys(left).length === 0) delete byId[id]
    else byId[id] = left
    return { byId }
  })
}

export function unsavedAt(id: string, slot: string): UnsavedChange | null {
  return useArtifactUnsavedStore.getState().byId[id]?.[slot] ?? null
}

export function unsavedOf(id: string): UnsavedChange[] {
  return Object.values(useArtifactUnsavedStore.getState().byId[id] ?? {})
}
