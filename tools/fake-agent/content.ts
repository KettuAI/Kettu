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

// A diagram with a title and Chinese text, one without `xmlns` and with `&nbsp;` as agents
// write SVG for a web page, and path data with no `<svg>` around it.
export const SVG_REPLY = `Here is the release flow as a diagram:

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="236" viewBox="0 0 360 236" font-family="system-ui, sans-serif">
  <title>Release flow</title>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#555"/>
    </marker>
  </defs>
  <rect x="110" y="12" width="140" height="36" rx="18" fill="#e8f0fe" stroke="#4a7bd0"/>
  <text x="180" y="35" text-anchor="middle" font-size="14" fill="#222">开始 Start</text>
  <line x1="180" y1="48" x2="180" y2="88" stroke="#555" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="80" y="92" width="200" height="44" rx="8" fill="#fff" stroke="#333"/>
  <text x="180" y="119" text-anchor="middle" font-size="14" fill="#222">git push origin main</text>
  <line x1="180" y1="136" x2="180" y2="176" stroke="#555" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="110" y="180" width="140" height="36" rx="18" fill="#e6f4ea" stroke="#3c8d4f"/>
  <text x="180" y="203" text-anchor="middle" font-size="14" fill="#222">发布 Release</text>
</svg>
\`\`\`

The same badge, written for a web page:

\`\`\`svg
<svg width="120" height="28" viewBox="0 0 120 28">
  <rect width="120" height="28" rx="6" fill="#24292f"/>
  <text x="60" y="18" text-anchor="middle" font-size="12" fill="#fff" font-family="system-ui">build&nbsp;passing</text>
</svg>
\`\`\`

And the arrow on its own, which is only path data:

\`\`\`svg
M0,0 L8,4 L0,8 z
\`\`\`
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

/** A long answer in Chinese that uses every Markdown block, for checking CJK prose. */
export const CHINESE_ANSWER = `## 登录测试为什么会偶发失败

我读了 \`src/clock.ts\` 和 \`src/auth/token.ts\`，问题出在**令牌过期时间被读取了两次时钟**：签发时读一次，校验时又读一次。CI 机器负载高的时候，两次读取之间可能恰好跨过一秒的边界，于是刚签发的令牌就被判定为已过期。

这类问题在本地几乎复现不了，因为开发机够快；但在共享的 CI 环境里，大约每一百次运行会失败一两次。*偶发失败最难排查*，因为重跑一次往往就过了。

### 修复思路

1. 在请求入口处只读一次时钟，得到一个 \`now\`。
2. 把这个 \`now\` 一路传给 \`issueToken\` 和 \`validate\`，不再各自调用 \`Date.now()\`。
3. 用假时钟写一个测试，把时间精确地停在边界前后各一毫秒。

> 同一个请求里，所有和时间有关的判断都应该基于同一个时间点。这比给过期时间加一点余量更可靠。

改动后的签发函数大致如下：

\`\`\`ts
// The caller reads the clock once and passes it down.
export function issueToken(user: User, now: number): Token {
  return { user: user.id, expiresAt: now + TOKEN_TTL_MS }
}

export function validate(token: Token, now: number): boolean {
  return token.expiresAt > now
}
\`\`\`

### 影响范围

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| \`src/auth/token.ts\` | +12 −8 | 签发和校验都改为接收 \`now\` |
| \`src/middleware/session.ts\` | +3 −1 | 在入口处读取一次时钟 |
| \`test/auth.test.ts\` | +41 −0 | 新增边界测试 |

- 这次修改不影响令牌的格式，已经签发的令牌仍然有效。
- 其他调用 \`validate\` 的地方共有 7 处，都在同一个中间件里，已经一并更新。
- 假时钟用的是 Vitest 自带的 \`vi.useFakeTimers()\`，不需要新增依赖。

---

如果你愿意，我可以再检查一下其他模块里有没有类似的"读两次时钟"的写法。相关的讨论可以参考 [Vitest 的假时钟文档](https://vitest.dev/guide/mocking.html#timers)。
`
