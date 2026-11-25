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
 * which wraps around at either end; `from` is the run the last step went to. Returns which run it
 * went to, from 1, and how many there are.
 */
export function stepChange(
  scroller: RefObject<HTMLElement | null>,
  direction: 1 | -1,
  from: number | null,
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
  const stops = starts
    .map((row) => ({ row, offset: Math.round(row.getBoundingClientRect().top - top) }))
    .sort((a, b) => a.offset - b.offset)
    // Side by side, a run that changes lines starts in both columns at one height: one stop.
    .filter((stop, i, all) => i === 0 || stop.offset !== all[i - 1]!.offset)
  // At the end of the scroll a run low in the view never reaches the top, so it would be found
  // again: step on from the last run gone to instead.
  const atEnd = box.scrollTop >= box.scrollHeight - box.clientHeight - 1
  let index =
    atEnd && from !== null && from <= stops.length
      ? (from - 1 + direction + stops.length) % stops.length
      : direction === 1
        ? stops.findIndex((stop) => stop.offset > 2)
        : stops.findLastIndex((stop) => stop.offset < -2)
  if (index < 0) index = direction === 1 ? 0 : stops.length - 1
  stops[index]?.row.scrollIntoView({ block: 'start' })
  return { current: index + 1, total: stops.length }
}
