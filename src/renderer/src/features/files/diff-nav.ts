// Parsing and stepping through the changes the Files pane's diff draws.

import { useMemo, type RefObject } from 'react'
import { DIFFS_TAG_NAME, parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'

/** A file's change, parsed once for the diff to draw and the footer to count its hunks. */
export function useParsedDiff(
  path: string,
  oldText: string | null,
  newText: string,
): FileDiffMetadata {
  return useMemo(
    () =>
      parseDiffFromFile(oldText === null ? null : { name: path, contents: oldText }, {
        name: path,
        contents: newText,
      }),
    [path, oldText, newText],
  )
}

/**
 * Scrolls the diff to the next or the previous run of changed lines from the top of its view,
 * which wraps around at either end. Returns which run it went to, from 1, and how many there are.
 */
export function stepChange(
  scroller: RefObject<HTMLElement | null>,
  direction: 1 | -1,
): { current: number; total: number } | null {
  const box = scroller.current
  const rows = box
    ?.querySelector(DIFFS_TAG_NAME)
    // The lines themselves: the gutter repeats each row's type beside them.
    ?.shadowRoot?.querySelectorAll<HTMLElement>('[data-line][data-line-type^="change-"]')
  if (!box || !rows?.length) return null
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
  return { current: index + 1, total: starts.length }
}
