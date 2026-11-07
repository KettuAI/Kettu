import { memo, useMemo } from 'react'
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import { FileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useCodeThemes } from '@renderer/features/session/markdown/code-themes'
import { diffsPool as pool } from '@renderer/features/session/markdown/diff-pool'
import { useDark } from '@renderer/hooks/use-dark'
import { hunkHeader } from './hunk-header'

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

// The hunk header sits on the first line, with the diff's 6px margin above it.
const CODE_SPACING = '[data-code]{padding-block:0 6px}'

/**
 * The Files pane's diff of a parsed change: unified, a bar along each changed line, the first
 * hunk's header above, unchanged runs folded, lines selectable by their numbers to mention them.
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
      diffIndicators: 'bars' as const,
      hunkSeparators: 'line-info' as const,
      lineDiffType: 'word' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
      enableLineSelection: true,
      onLineSelected: onSelect,
      unsafeCSS: TINTS_AS_GIVEN + FLAT_SEPARATOR + CODE_SPACING,
    }),
    [dark, theme, onSelect],
  )
  const first = fileDiff.hunks[0]
  return (
    <WorkerPoolContext.Provider value={pool}>
      {first && (
        <div className="mt-1.5 bg-hover px-3 py-0.5 font-mono text-code leading-5.25 text-disabled select-none">
          {hunkHeader(first)}
        </div>
      )}
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
