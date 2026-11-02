import { memo, useMemo } from 'react'
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import { FileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useCodeThemes } from '@renderer/features/session/markdown/code-themes'
import { diffsPool as pool } from '@renderer/features/session/markdown/diff-pool'
import { useDark } from '@renderer/hooks/use-dark'

// @pierre/diffs mixes a changed row's tint into the background once more, which leaves a
// translucent tint all but invisible, so the tints are laid on as they are.
const TINTS_AS_GIVEN =
  '[data-line],[data-no-newline],[data-gutter-buffer],[data-column-number]{--mix-light:0%;--mix-dark:0%}'

// The folded lines between hunks as a flat strip across the diff rather than the library's
// rounded, inset bar, whose height, gaps and corners no variable sets.
const FLAT_SEPARATOR = [
  '[data-separator=line-info]{height:26px;margin-block:0}',
  '[data-separator=line-info] [data-separator-wrapper]{padding-inline:12px;column-gap:8px;grid-template-columns:auto 1fr;background-color:var(--diffs-bg-separator)}',
  '[data-separator=line-info] :is([data-expand-button],[data-separator-content]){border-radius:0}',
  '[data-separator=line-info] [data-expand-button]{min-width:0;border:0}',
  '[data-separator=line-info] [data-separator-content]{padding:0}',
].join('')

/**
 * The Files pane's diff of a parsed change: unified, one column of line numbers, + and − in the
 * gutter, unchanged runs folded, lines selectable to mention them.
 */
function FilesDiffImpl({
  fileDiff,
  selected,
  onSelect,
}: {
  fileDiff: FileDiffMetadata
  selected: SelectedLineRange | null
  onSelect: (range: SelectedLineRange | null) => void
}) {
  const dark = useDark()
  const theme = useCodeThemes()
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
      unsafeCSS: TINTS_AS_GIVEN + FLAT_SEPARATOR,
    }),
    [dark, theme, onSelect],
  )
  return (
    <WorkerPoolContext.Provider value={pool}>
      <FileDiff
        fileDiff={fileDiff}
        options={options}
        selectedLines={selected}
        className="files-diff"
      />
    </WorkerPoolContext.Provider>
  )
}

export const FilesDiff = memo(FilesDiffImpl)
