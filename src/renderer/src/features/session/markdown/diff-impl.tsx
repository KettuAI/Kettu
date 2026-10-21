import { memo, useMemo } from 'react'
import { MultiFileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'
import { codeTheme as theme, diffsPool as pool } from './diff-pool'
import type { DiffProps } from './index'

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
