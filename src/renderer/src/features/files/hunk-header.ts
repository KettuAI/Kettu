import type { Hunk } from '@pierre/diffs'

/** "@@ -1,8 +1,9 @@", without the function name git may add after it. */
export function hunkHeader(
  hunk: Pick<
    Hunk,
    'hunkSpecs' | 'deletionStart' | 'deletionCount' | 'additionStart' | 'additionCount'
  >,
): string {
  const given = hunk.hunkSpecs && /^@@ [^@]+ @@/.exec(hunk.hunkSpecs)?.[0]
  return (
    given ||
    `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`
  )
}
