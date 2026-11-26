/**
 * Shared slash-token helpers used by both the composer and the agent host.
 *
 * A slash token starts at the beginning of the text, after whitespace, or after
 * a non-ASCII character (such as CJK text), never after an ASCII character like
 * a letter, digit, or path separator (`a/b` and `https://...` stay plain text).
 */

export interface SkillToken {
  from: number
  to: number
  name: string
}

/** Characters that cleanly end an inline `/skill` token (whitespace, punctuation, or non-ASCII). */
const TOKEN_END = /[\s.,;:!?)\]}>'"。，；：！？）、]/

/** Whether a `/` at `at` starts a slash word rather than continuing an ASCII path or URL. */
export function startsSlashWord(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text.charCodeAt(at - 1)
  return /\s/.test(text[at - 1]!) || before > 0x7f
}

/** Whether `pos` cleanly ends a `/skill` token (end of text, whitespace, punctuation, or non-ASCII). */
function endsSlashWord(text: string, pos: number): boolean {
  if (pos >= text.length) return true
  const ch = text[pos]!
  return TOKEN_END.test(ch) || ch.charCodeAt(0) > 0x7f
}

/**
 * Every `/name` skill token in `text`, in order. Only names in `skillNames` match
 * (exact case, since agents receive the text as typed), preceded by a word boundary
 * and followed by whitespace, end-of-text, sentence punctuation, or non-ASCII text.
 */
export function findSkillTokens(text: string, skillNames: readonly string[]): SkillToken[] {
  if (skillNames.length === 0 || !text.includes('/')) return []
  // Longest first so a shorter prefix name never shadows a longer skill name.
  const ordered = [...new Set(skillNames.filter(Boolean))].sort((a, b) => b.length - a.length)
  const tokens: SkillToken[] = []
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('/', i)
    if (at < 0) break
    if (!startsSlashWord(text, at)) {
      i = at + 1
      continue
    }
    let matched: string | null = null
    for (const name of ordered) {
      const end = at + 1 + name.length
      if (text.startsWith(name, at + 1) && endsSlashWord(text, end)) {
        matched = name
        break
      }
    }
    if (matched) {
      const to = at + 1 + matched.length
      tokens.push({ from: at, to, name: matched })
      i = to
    } else {
      i = at + 1
    }
  }
  return tokens
}

/** Distinct skill names referenced in `text`, in order of first appearance. */
export function mentionedSkills(text: string, skillNames: readonly string[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const token of findSkillTokens(text, skillNames)) {
    if (seen.has(token.name)) continue
    seen.add(token.name)
    names.push(token.name)
  }
  return names
}
