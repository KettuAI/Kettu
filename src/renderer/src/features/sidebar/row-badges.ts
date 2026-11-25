const BADGE_IN_USE =
  ':is([data-subagent-badge], [data-worktree-mark], [data-pr-badge]):is(:hover, [data-popup-open])'

/** A row's card stays shut while the pointer is on one of its badges or a badge's own card shows. */
export function badgeInUse(row: HTMLElement | null): boolean {
  return !!row?.querySelector(BADGE_IN_USE)
}
