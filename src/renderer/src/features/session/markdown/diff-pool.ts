import { registerCustomTheme } from '@pierre/diffs'
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker'
// The self-contained build: worker.js's own chunks import it back, which the dev server serves
// under another URL, so each worker ran a second, uninitialized copy that failed every request.
import DiffsWorker from '@pierre/diffs/worker/worker-portable.js?worker'
import { THEME_MODES } from '@shared/themes'
import { isWeb } from '@renderer/lib/platform'
import { useThemesStore } from '@renderer/stores/themes'
import { codeThemes, KETTU_CODE_THEMES, kettuCodeTheme } from './code-themes'

let themesRegistered = false
let pool: WorkerPoolManager | null = null
let themeSubscribed = false

function registerThemesOnce(): void {
  if (themesRegistered) return
  themesRegistered = true
  for (const mode of THEME_MODES) {
    registerCustomTheme(KETTU_CODE_THEMES[mode], () => Promise.resolve(kettuCodeTheme(mode)))
  }
}

/**
 * Shared diff worker pool, created lazily when the first diff mounts so sessions without open
 * diffs never spawn Shiki workers. Web keeps a single worker and a smaller AST cache to bound
 * browser tab memory.
 */
export function getDiffsPool(): WorkerPoolManager {
  if (!pool) {
    registerThemesOnce()
    const concurrency =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4
    pool = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new DiffsWorker(),
        poolSize: isWeb ? 1 : Math.min(2, Math.max(1, concurrency - 2)),
        totalASTLRUCacheSize: isWeb ? 20 : 50,
      },
      highlighterOptions: {
        theme: codeThemes(useThemesStore.getState().shown),
        preferredHighlighter: 'shiki-js',
      },
    })
  }
  if (!themeSubscribed) {
    themeSubscribed = true
    // The pool's theme wins over each diff's own, and every diff re-renders when it changes.
    useThemesStore.subscribe((state, previous) => {
      if (state.shown === previous.shown || !pool) return
      pool
        .setRenderOptions({ theme: codeThemes(state.shown) })
        .catch((error: unknown) => console.warn('Diffs could not take the theme', error))
    })
  }
  return pool
}
