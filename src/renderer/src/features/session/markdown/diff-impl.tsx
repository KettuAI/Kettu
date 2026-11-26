import { memo, useEffect, useMemo, useState } from 'react'
import { MultiFileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'
import { useDiffStyle, type DiffStyle } from '@renderer/stores/diff-style'
import { useCodeThemes } from './code-themes'
import { getDiffsPool } from './diff-pool'
import type { DiffProps } from './index'

// Side by side needs room for two columns of code, so a diff narrower than this, as in a thread
// column of the default width, stays unified whatever was chosen.
const SPLIT_MIN_WIDTH = 960

/** Whether `box` is wide enough to lay the diff side by side, watched only while `watch`. */
function useWideEnough(box: HTMLElement | null, watch: boolean): boolean {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    if (!box || !watch) return
    const observer = new ResizeObserver(() => setWide(box.clientWidth >= SPLIT_MIN_WIDTH))
    observer.observe(box)
    return () => observer.disconnect()
  }, [box, watch])
  return watch && wide
}

function DiffImpl({ path, oldText, newText, className }: DiffProps) {
  const dark = useDark()
  const theme = useCodeThemes()
  const chosen = useDiffStyle((s) => s.style)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const diffStyle: DiffStyle = useWideEnough(box, chosen === 'split') ? 'split' : 'unified'
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
      diffStyle,
      overflow: 'wrap' as const,
      diffIndicators: 'bars' as const,
      hunkSeparators: 'line-info-basic' as const,
      lineDiffType: 'word' as const,
      disableFileHeader: true,
      preferredHighlighter: 'shiki-js' as const,
    }),
    [dark, theme, diffStyle],
  )
  const pool = useMemo(() => getDiffsPool(), [])
  return (
    <WorkerPoolContext.Provider value={pool}>
      <div ref={setBox}>
        <MultiFileDiff
          {...(files.oldFile
            ? { oldFile: files.oldFile, newFile: files.newFile }
            : { oldFile: null, newFile: files.newFile })}
          options={options}
          className={cn('diff', className)}
        />
      </div>
    </WorkerPoolContext.Provider>
  )
}

export default memo(DiffImpl)
