// Text that looks like a credential, which memory refuses: every agent is handed memory and it is
// kept in plain files.

interface SecretShape {
  name: string
  pattern: RegExp
  /** Checks the first group, or the whole match, to keep ordinary words out. */
  check?(value: string): boolean
}

/** Real keys and tokens mix letters and digits; words joined by dashes do not. */
function mixed(value: string): boolean {
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

const SHAPES: readonly SecretShape[] = [
  { name: 'a private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'an API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, check: mixed },
  {
    name: 'a GitHub token',
    pattern: /\b(?:gh[opsur]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  },
  { name: 'a Slack token', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { name: 'an AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'a GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'a JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./g },
  { name: 'a bearer token', pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{20,})/g, check: mixed },
  {
    name: 'a password or token',
    pattern:
      /\b[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["'`]?([A-Za-z0-9._~+/-]{12,})/gi,
    check: mixed,
  },
]

/** What kind of secret the text seems to hold, such as `a GitHub token`; null when none. */
export function secretKind(text: string): string | null {
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      if (!shape.check || shape.check(match[1] ?? match[0])) return shape.name
    }
  }
  return null
}
