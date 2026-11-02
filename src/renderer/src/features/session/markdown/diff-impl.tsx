import { memo, useMemo } from 'react'
import { MultiFileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'
import { useCodeThemes } from './code-themes'
import { diffsPool as pool } from './diff-pool'
import type { DiffProps } from './index'

// Inside the diff's shadow root, where outer CSS cannot reach. The library mixes the line tints
// into the ground at 88 to 91 percent, so a changed line takes its tint as given instead; and a
// fold is one plain row of code type, its chevron beside its text.
const FRAMED_CSS = `
[data-line], [data-no-newline], [data-column-number], [data-gutter-buffer] {
  --mix-light: 0%;
  --mix-dark: 0%;
}
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
      // A reply's block shows + and - signs.
      diffIndicators: framed ? ('classic' as const) : ('bars' as const),
      hunkSeparators: 'line-info-basic' as const,
      lineDiffType: 'word' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
      unsafeCSS: framed ? FRAMED_CSS : undefined,
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
