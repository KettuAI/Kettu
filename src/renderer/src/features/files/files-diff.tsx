import { memo, useMemo } from 'react'
import type { SelectedLineRange } from '@pierre/diffs'
import { MultiFileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useCodeThemes } from '@renderer/features/session/markdown/code-themes'
import { diffsPool as pool } from '@renderer/features/session/markdown/diff-pool'
import { useDark } from '@renderer/hooks/use-dark'

/**
 * The Files pane's diff: unified, both line numbers, + and − in the gutter, unchanged runs folded,
 * lines selectable to mention them.
 */
function FilesDiffImpl({
  path,
  oldText,
  newText,
  selected,
  onSelect,
}: {
  path: string
  oldText: string | null
  newText: string
  selected: SelectedLineRange | null
  onSelect: (range: SelectedLineRange | null) => void
}) {
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
      overflow: 'scroll' as const,
      diffIndicators: 'classic' as const,
      hunkSeparators: 'line-info' as const,
      lineDiffType: 'word' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
      enableLineSelection: true,
      onLineSelected: onSelect,
    }),
    [dark, theme, onSelect],
  )
  return (
    <WorkerPoolContext.Provider value={pool}>
      <MultiFileDiff
        {...(files.oldFile
          ? { oldFile: files.oldFile, newFile: files.newFile }
          : { oldFile: null, newFile: files.newFile })}
        options={options}
        selectedLines={selected}
        className="files-diff"
      />
    </WorkerPoolContext.Provider>
  )
}

export const FilesDiff = memo(FilesDiffImpl)
