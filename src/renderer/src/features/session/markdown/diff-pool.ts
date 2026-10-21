import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

export const codeTheme = { light: 'github-light-default', dark: 'github-dark-default' } as const

// One pool for the app's lifetime, shared by diffs and the Files pane's preview: the provider
// component would terminate it whenever the last diff unmounts, which happens every time a tool
// card collapses.
export const diffsPool = getOrCreateWorkerPoolSingleton({
  poolOptions: {
    workerFactory: () => new DiffsWorker(),
    poolSize: Math.min(4, Math.max(1, navigator.hardwareConcurrency - 2)),
  },
  highlighterOptions: { theme: codeTheme, preferredHighlighter: 'shiki-js' },
})
