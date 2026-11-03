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

// The old and new line numbers side by side, 30px each, then a 20px column for + and −. The old
// number of an unchanged line comes from `withOldNumbers`; a removed line's number is its old one.
const TWO_NUMBER_COLUMNS = [
  '[data-column-number]{display:flex;justify-content:flex-end;padding-inline:0}',
  '[data-column-number]::before{content:attr(data-alt-line);width:30px;text-align:right}',
  '[data-line-number-content]{width:30px;min-width:0;text-align:right}',
  '[data-column-number][data-line-type=change-deletion] [data-line-number-content]{order:-1}',
  '[data-indicators=classic] [data-line]{padding-inline-start:20px}',
  '[data-indicators=classic] [data-line]::before{width:20px;text-align:center}',
  // The hunk header sits on the first line, with the diff's 6px margin above it.
  '[data-code]{padding-block:0 6px}',
].join('')

/**
 * The library's unified gutter holds one number a line, the new one where there is one. An
 * unchanged line's old number is only on its code row, so it is copied to the gutter for the
 * second column, after every render since a render rebuilds the gutter.
 */
function withOldNumbers(node: HTMLElement): void {
  const root = node.shadowRoot ?? node
  const old = new Map<string, string>()
  for (const line of root.querySelectorAll<HTMLElement>('[data-content] [data-alt-line]')) {
    const { lineIndex, altLine } = line.dataset
    if (lineIndex && altLine) old.set(lineIndex, altLine)
  }
  for (const cell of root.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]')) {
    const number = old.get(cell.dataset.lineIndex ?? '')
    if (number) cell.dataset.altLine = number
    else delete cell.dataset.altLine
  }
}

/**
 * The Files pane's diff of a parsed change: unified, old and new line numbers, + and − in their
 * own column, the first hunk's header above, unchanged runs folded, lines selectable to mention
 * them.
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
      onPostRender: withOldNumbers,
      unsafeCSS: TINTS_AS_GIVEN + FLAT_SEPARATOR + TWO_NUMBER_COLUMNS,
    }),
    [dark, theme, onSelect],
  )
  const first = fileDiff.hunks[0]
  return (
    <WorkerPoolContext.Provider value={pool}>
      {first && (
        <div className="mt-1.5 bg-subtle px-3 py-0.5 font-mono text-code leading-5.25 text-(--syntax-comment) select-none">
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
