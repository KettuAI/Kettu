import { memo, useMemo } from 'react'
import { MultiFileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'
import type { DiffProps } from './index'

const theme = { light: 'github-light-default', dark: 'github-dark-default' } as const

// One pool for the app's lifetime: the provider component would terminate it whenever the last
// diff unmounts, which happens every time a tool card collapses.
const pool = getOrCreateWorkerPoolSingleton({
  poolOptions: {
    workerFactory: () => new DiffsWorker(),
    poolSize: Math.min(4, Math.max(1, navigator.hardwareConcurrency - 2)),
  },
  highlighterOptions: { theme, preferredHighlighter: 'shiki-js' },
})

function DiffImpl({ path, oldText, newText, className }: DiffProps) {
  const dark = useDark()
  const files = useMemo(
    () => ({
      oldFile: oldText === null ? null : { name: path, contents: oldText },
      newFile: { name: path, contents: newText },
    }),
    [path, oldText, newText],
  )
  const options = useMemo(
    () => ({
      theme,
      themeType: dark ? ('dark' as const) : ('light' as const),
      diffStyle: 'unified' as const,
      overflow: 'wrap' as const,
      diffIndicators: 'bars' as const,
      hunkSeparators: 'line-info-basic' as const,
      lineDiffType: 'word' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
    }),
    [dark],
  )
  return (
    <WorkerPoolContext.Provider value={pool}>
      <MultiFileDiff
        {...(files.oldFile
          ? { oldFile: files.oldFile, newFile: files.newFile }
          : { oldFile: null, newFile: files.newFile })}
        options={options}
        className={cn('diff', className)}
      />
    </WorkerPoolContext.Provider>
  )
}

export default memo(DiffImpl)
