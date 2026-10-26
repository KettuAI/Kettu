/** Whether a web link asks before it opens in the default browser. */
export function asksBeforeOpening(url: string, confirmLinks: boolean): boolean {
  return confirmLinks || hasUserinfo(url)
}

/**
 * Whether the address carries a user name or a password, whose text before "@" can pass for
 * another site.
 */
export function hasUserinfo(url: string): boolean {
  const parsed = URL.parse(url)
  return !!parsed && (parsed.username !== '' || parsed.password !== '')
}
