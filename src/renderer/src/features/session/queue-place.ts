/** The message the queue card shows: the one it showed, while it still waits; else its place. */
export function shownPlace(
  ids: readonly string[],
  shown: { id: string | null; index: number },
): number {
  const found = shown.id === null ? -1 : ids.indexOf(shown.id)
  return found >= 0 ? found : Math.min(shown.index, ids.length - 1)
}
