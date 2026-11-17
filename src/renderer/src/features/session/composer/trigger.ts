/**
 * Whether a sign typed at `at` starts a word the composer reacts to: at the start, after a space,
 * or after text that has no spaces, such as Chinese. Not after an ASCII character, so `a@b` and
 * `a/b` stay text.
 */
export function startsWord(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text.charCodeAt(at - 1)
  return /\s/.test(text[at - 1]!) || before > 0x7f
}
