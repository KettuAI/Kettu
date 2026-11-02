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

// A removed line's sign is a minus, as the header's count is, and a changed word's tint keeps
// tight corners.
const MARKS =
  "[data-line-type=change-deletion]:is([data-line],[data-no-newline])::before{content:'\\2212'}[data-diff-span]{border-radius:2px}"

// Inside the diff's shadow root, where outer CSS cannot reach: in a reply's block frame a fold is
// one plain row of code type, its chevron beside its text.
const FRAMED_FOLDS = `
[data-separator='line-info-basic'] {
  height: 26px;
  font-family: var(--diffs-font-family);
}
[data-gutter] [data-separator='line-info-basic'] [data-separator-wrapper] {
  display: flex;
  gap: 8px;
  width: max-content;
  padding: 0 12px;
  background: none;
}
[data-separator='line-info-basic'] [data-expand-button] {
  min-width: 0;
  border: 0;
  background: none;
}
[data-separator='line-info-basic'] [data-icon] {
  width: 11px;
  height: 11px;
}
[data-separator='line-info-basic'] [data-separator-content] {
  padding: 0;
  background: none;
}
`

function DiffImpl({ path, oldText, newText, className, framed = false }: DiffProps) {
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
      diffIndicators: 'classic' as const,
      hunkSeparators: 'line-info-basic' as const,
      lineDiffType: 'word' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
      unsafeCSS: TINTS_AS_GIVEN + MARKS + (framed ? FRAMED_FOLDS : ''),
    }),
    [dark, theme, framed],
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
