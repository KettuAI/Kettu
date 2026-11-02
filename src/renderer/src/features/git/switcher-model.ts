// Rules the branch switcher checks before it asks the host: a name git takes for a new branch,
// whether a session's folder is a worktree's, and the order it lists branches in.

/**
 * Whether git takes `name` as a new branch's name, by `git check-ref-format --branch`'s rules,
 * and it cannot read as an option.
 */
export function isBranchName(name: string): boolean {
  if (name === '' || name === '@' || name.startsWith('-') || name.startsWith('/')) return false
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  // Control characters and space, then ~ ^ : ? * [ and backslash.
  if ([...name].some((char) => char <= ' ' || char === '\u007f')) return false
  if (/[~^:?*[\\]/.test(name)) return false
  return name.split('/').every((part) => !part.startsWith('.'))
}

/** Whether two folders are one, as the host writes them; Windows paths ignore case. */
export function sameFolder(a: string, b: string): boolean {
  const windows = a.includes('\\') || b.includes('\\') || /^[a-z]:/i.test(a)
  const norm = (path: string): string => {
    const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return windows ? slashed.toLowerCase() : slashed
  }
  return norm(a) === norm(b)
}

/** The branches to switch to, newest first as given, with the default branch on top. */
export function recentBranches(
  names: readonly string[],
  current: string | null,
  defaultBranch: string | null,
): string[] {
  const others = names.filter((name) => name !== current && name !== defaultBranch)
  return defaultBranch !== null && defaultBranch !== current && names.includes(defaultBranch)
    ? [defaultBranch, ...others]
    : others
}
