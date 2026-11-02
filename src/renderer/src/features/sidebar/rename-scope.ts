import { createContext, useContext, useEffect } from 'react'
import { useViewStore } from '@renderer/stores/view'

/** The group a row sits in, whose end shows the rename keys; rows outside a group show them below. */
export const RenameScope = createContext<string | null>(null)

/**
 * Marks the row's group as renaming while `renaming`. Returns whether the row shows the keys
 * itself, which it does only outside a group.
 */
export function useRenameHints(renaming: boolean): boolean {
  const scope = useContext(RenameScope)
  useEffect(() => {
    if (!renaming || scope === null) return
    useViewStore.setState({ renamingIn: scope })
    return () => {
      if (useViewStore.getState().renamingIn === scope) useViewStore.setState({ renamingIn: null })
    }
  }, [renaming, scope])
  return renaming && scope === null
}
