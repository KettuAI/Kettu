import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import { useThemesStore } from '@renderer/stores/themes'
import { codeThemes } from './code-themes'

// One pool for the app's lifetime, shared by diffs and the Files pane's preview: the provider
// component would terminate it whenever the last diff unmounts, which happens every time a tool
// card collapses.
export const diffsPool = getOrCreateWorkerPoolSingleton({
  poolOptions: {
    workerFactory: () => new DiffsWorker(),
    poolSize: Math.min(4, Math.max(1, navigator.hardwareConcurrency - 2)),
  },
  highlighterOptions: {
    theme: codeThemes(useThemesStore.getState().shown),
    preferredHighlighter: 'shiki-js',
  },
})

// The pool's theme wins over each diff's own, and every diff re-renders when it changes.
useThemesStore.subscribe((state, previous) => {
  if (state.shown === previous.shown) return
  diffsPool
    .setRenderOptions({ theme: codeThemes(state.shown) })
    .catch((error: unknown) => console.warn('Diffs could not take the theme', error))
})
