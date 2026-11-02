// Counting and stepping through the changes the Files pane's diff draws.

import { useMemo, type RefObject } from 'react'
import { DIFFS_TAG_NAME, parseDiffFromFile } from '@pierre/diffs'

/** How many hunks a file's change has, as the diff below draws them. */
export function useHunkCount(path: string, oldText: string | null, newText: string): number {
  return useMemo(
    () =>
      parseDiffFromFile(
        oldText === null ? null : { name: path, contents: oldText },
        { name: path, contents: newText },
        undefined,
        false,
      ).hunks.length,
    [path, oldText, newText],
  )
}

/**
 * Scrolls the diff to the next or the previous run of changed lines from the top of its view,
 * which wraps around at either end.
 */
export function stepChange(scroller: RefObject<HTMLElement | null>, direction: 1 | -1): void {
  const box = scroller.current
  const rows = box
    ?.querySelector(DIFFS_TAG_NAME)
    ?.shadowRoot?.querySelectorAll<HTMLElement>('[data-line-type^="change-"]')
  if (!box || !rows?.length) return
  // The first row of each run: a change row whose row above is not one.
  const starts = Array.from(rows).filter(
    (row) => !row.previousElementSibling?.matches('[data-line-type^="change-"]'),
  )
  const top = box.getBoundingClientRect().top
  const offsets = starts.map((row) => row.getBoundingClientRect().top - top)
  let index =
    direction === 1
      ? offsets.findIndex((offset) => offset > 2)
      : offsets.findLastIndex((offset) => offset < -2)
  if (index < 0) index = direction === 1 ? 0 : starts.length - 1
  starts[index]?.scrollIntoView({ block: 'start' })
}
