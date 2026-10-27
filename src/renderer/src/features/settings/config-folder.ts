export type ConfigFolderMode = 'environment' | 'custom'

/** What the folder choice does to the step after a pick. */
export function configFolderChoice(
  mode: ConfigFolderMode,
  { chosen, choosing }: { chosen: boolean; choosing: boolean },
): { open: boolean; clear: boolean } {
  return {
    open: mode === 'custom' && (choosing || !chosen),
    clear: mode === 'environment' && chosen,
  }
}
