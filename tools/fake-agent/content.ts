// Realistic text for the fake agent's replies, so the interface has real content to render.

export const BASIC_REPLY = `## Plan

I looked at \`src/clock.ts\` and found why the login test is flaky: the token expiry is computed from two separate reads of the clock, so a slow CI runner can cross a second boundary between them.

1. Read the clock once per request.
2. Pass the timestamp down instead of calling \`Date.now()\` again.
3. Add a regression test that freezes time.

\`\`\`ts
export function issueToken(user: User, now = Date.now()): Token {
  return { user: user.id, expiresAt: now + TOKEN_TTL_MS }
}
\`\`\`

| File              | Change                      | Risk |
| ----------------- | --------------------------- | ---- |
| \`src/clock.ts\`    | Read the clock once         | Low  |
| \`src/session.ts\`  | Pass \`now\` through          | Low  |
| \`test/login.ts\`   | Freeze time in the test     | None |

See the [Node.js timers guide](https://nodejs.org/en/learn/asynchronous-work/understanding-processnexttick) for why this matters.
`

export const BASIC_NOTE = `The clock is read once now. Next, a regression test that freezes time.
`

export const BASIC_DONE = `

Done. The login and clock tests pass, so the flake is gone.
`

export const THOUGHT_TEXT = `The user wants to know why the test fails only on CI. CI runners are slower and share CPU, so anything that depends on wall-clock time between two statements can flip. Let me check where the clock is read. \`issueToken\` calls \`Date.now()\` and \`validate\` calls it again; if a second boundary falls between them the computed expiry differs by one second. That would explain a one-in-fifty failure rate. Before editing, I should confirm no other caller depends on the second read, because \`refresh\` also calls \`validate\` with its own timestamp. The safest change is to thread one timestamp through both functions and keep the default parameter for existing callers. I also want a regression test that freezes time with fake timers so the failure cannot come back silently.`

export const THINKING_ANSWER = `## Answer

The flake comes from reading the clock twice. Threading a single timestamp through \`issueToken\` and \`validate\` removes the race, and a fake-timer test keeps it fixed.

- **Cause**: two \`Date.now()\` calls straddling a second boundary
- **Fix**: one read, passed down as \`now\`
- **Guard**: a test with \`vi.useFakeTimers()\`
`

export const CLOCK_BEFORE = `export function issueToken(user: User): Token {
  return { user: user.id, expiresAt: Date.now() + TOKEN_TTL_MS }
}

export function validate(token: Token): boolean {
  return token.expiresAt > Date.now()
}
`

export const CLOCK_AFTER = `export function issueToken(user: User, now = Date.now()): Token {
  return { user: user.id, expiresAt: now + TOKEN_TTL_MS }
}

export function validate(token: Token, now = Date.now()): boolean {
  return token.expiresAt > now
}
`

export const CLOCK_TEST = `import { afterEach, expect, it, vi } from 'vitest'
import { issueToken, validate } from '../src/clock'

afterEach(() => vi.useRealTimers())

it('keeps a token valid when a second passes while it is issued', () => {
  vi.useFakeTimers({ now: 1_999 })
  const token = issueToken({ id: 'u1' })
  vi.setSystemTime(2_000)
  expect(validate(token, 1_999)).toBe(true)
})
`

const SECTION_TOPICS = [
  'Session lifecycle',
  'Streaming updates',
  'Permission requests',
  'Tool call rendering',
  'Plan tracking',
  'Cancellation',
  'Crash recovery',
  'Persistence',
]

/** Markdown of about `bytes` characters, made of varied sections. */
export function longMarkdown(bytes: number): string {
  const parts: string[] = []
  let size = 0
  let index = 0
  while (size < bytes) {
    const topic = SECTION_TOPICS[index % SECTION_TOPICS.length]!
    const section = `## ${index + 1}. ${topic}

This section walks through ${topic.toLowerCase()} in detail. Each paragraph is long enough to wrap a few times, so the renderer has real layout work to do while text streams in.

- Item one for section ${index + 1}, with \`inline code\` and **bold text**
- Item two, with a [link](https://agentclientprotocol.com/protocol/overview)
- Item three, which is a little longer than the others to vary the line length

\`\`\`ts
function step${index + 1}(input: string): string {
  return input.trim().toLowerCase() + '-${index + 1}'
}
\`\`\`

| Step | Status | Notes |
| ---- | ------ | ----- |
| ${index + 1}.1 | done | first pass |
| ${index + 1}.2 | done | second pass |

`
    parts.push(section)
    size += section.length
    index++
  }
  return parts.join('').slice(0, bytes)
}

/** Splits text into chunks of roughly `size` characters, preferring word boundaries. */
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      if (space > start + size / 2) end = space + 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/** Splits text into word-sized chunks, like a model streaming tokens. */
export function tokenChunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? []
}

const FILES = [
  'src/auth/login.ts',
  'src/auth/session.ts',
  'src/clock.ts',
  'src/db/users.ts',
  'src/http/router.ts',
  'test/login.test.ts',
  'README.md',
  'package.json',
]

export function fakeFile(index: number): string {
  return FILES[index % FILES.length]!
}

export const COMMANDS = ['pnpm test', 'git status --short', 'pnpm lint', 'ls src', 'pnpm build']

/** Output of a fake command; Windows-style tools often print CRLF, so some of it does. */
export function commandOutput(command: string, index: number): string {
  const eol = index % 3 === 0 ? '\r\n' : '\n'
  return [`$ ${command}`, 'checking 42 files', `done in ${(index % 7) + 1}.2s`, ''].join(eol)
}
