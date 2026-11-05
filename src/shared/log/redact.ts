// Masks secrets in text bound for a log file: values Kettu knows, common secret shapes, and the
// home folder, so a log can be shared without leaking keys or the user's name.

export const REDACTED = '<redacted>'

// The shortest value masked by value; anything shorter would mask ordinary words.
const MIN_SECRET_LENGTH = 8

const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
const AUTH_HEADER =
  /\b((?:proxy-)?authorization\b["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b)[^\s"',;]+/gi
const API_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']+@/gi
// A name like api_key, token or password, then `=` or `:`, then its value. A quoted name is
// matched with its closing quote, as in JSON.
const NAMED_SECRET =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"'&,;}\]]+)/gi
// Values that a secret-like name may carry without being a secret: counts such as inputTokens.
const PLAIN_VALUE = /^(?:\d+(?:\.\d+)?|true|false|null|undefined|none|\*+|<redacted>)$/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface Redactor {
  /** Text with every secret masked and the home folder written as `~`. */
  (text: string): string
}

export interface RedactorOptions {
  /** The user's home folder, written as `~`. */
  home?: string
  platform?: NodeJS.Platform
  /** Values to mask wherever they appear, such as tokens Kettu holds. */
  secrets?: () => Iterable<string>
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const homes = homePatterns(options.home, options.platform ?? process.platform)
  return (text) => {
    let out = text
    if (options.secrets) {
      for (const secret of options.secrets()) {
        if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED)
      }
    }
    out = out
      .replace(PRIVATE_KEY, REDACTED)
      .replace(BEARER, (_, scheme: string) => `${scheme} ${REDACTED}`)
      .replace(AUTH_HEADER, (_, name: string) => `${name}${REDACTED}`)
      .replace(API_KEY, REDACTED)
      .replace(GITHUB_TOKEN, REDACTED)
      .replace(AWS_KEY, REDACTED)
      .replace(JWT, REDACTED)
      .replace(URL_PASSWORD, (_, prefix: string) => `${prefix}${REDACTED}@`)
      .replace(NAMED_SECRET, (match, name: string, value: string) =>
        PLAIN_VALUE.test(value) ? match : `${name}${REDACTED}`,
      )
    for (const home of homes) out = out.replace(home, '~')
    return out
  }
}

/** The home folder as it appears in text: plain, and with backslashes escaped as in JSON. */
function homePatterns(home: string | undefined, platform: NodeJS.Platform): RegExp[] {
  if (!home || home.length < 2) return []
  const trimmed = home.replace(/[\\/]+$/, '')
  const forms = new Set([trimmed, trimmed.replace(/\\/g, '\\\\')])
  if (platform === 'win32') forms.add(trimmed.replace(/\\/g, '/'))
  const flags = platform === 'win32' ? 'gi' : 'g'
  // Only a whole path segment: /Users/ann must not match /Users/anna.
  return [...forms].map(
    (form) => new RegExp(`${escapeRegExp(form)}(?=$|[\\\\/"'\\s:;,)\\]}])`, flags),
  )
}
