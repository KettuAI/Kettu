// Line counts of diffs, off the renderer's main thread: a large file's diff takes long to compute.

import type { DiffJob, DiffJobResult } from '../entries/use-diff-stats'
import { diffStats } from './diff-stats'

const scope = self as unknown as Worker

scope.onmessage = (event: MessageEvent<DiffJob>) => {
  const { id, diffs } = event.data
  const stats = diffs.map((diff) => {
    try {
      return diffStats(diff.path, diff.oldText, diff.newText)
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) }
    }
  })
  const result: DiffJobResult = { id, stats }
  scope.postMessage(result)
}
