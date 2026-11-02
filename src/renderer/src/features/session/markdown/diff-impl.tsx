import { memo, useMemo } from 'react'
import { MultiFileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'
import { useCodeThemes } from './code-themes'
import { diffsPool as pool } from './diff-pool'
import type { DiffProps } from './index'

// @pierre/diffs mixes a changed row's tint into the background once more, at 12% in light and
// 20% in dark, which leaves a translucent tint all but invisible. The tints are laid on as they
// are instead, over the code surface.
const TINTS_AS_GIVEN =
  '[data-line],[data-no-newline],[data-gutter-buffer],[data-column-number]{--mix-light:0%;--mix-dark:0%}'

function DiffImpl({ path, oldText, newText, className }: DiffProps) {
  const dark = useDark()
  const theme = useCodeThemes()
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
      unsafeCSS: TINTS_AS_GIVEN,
    }),
    [dark, theme],
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
