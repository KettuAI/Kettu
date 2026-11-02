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

/**
 * The reasoning scenario's thoughts: raw reasoning, as many models send it through every agent,
 * with the short summary that summarizing models send in its place.
 */
export const REASONING: { raw: string; summary: string }[] = [
  {
    raw: `The user says the login test fails on CI but never locally. What differs on CI: slower runners, shared CPU, maybe another timezone, and test files running in parallel. The test checks that a token issued at login is still valid on the next request. If \`issueToken\` reads \`Date.now()\` and \`validate\` reads it again, a slow runner can cross a second boundary between the two reads, and with the expiry kept in whole seconds the token could look expired. But the TTL is fifteen minutes, so one second of drift should not expire it... unless the test sets a TTL of one second to cover expiry. I should read the test before guessing further, and check whether \`refresh\` calls \`validate\` with a timestamp of its own, which would be a second place that reads the clock. First \`src/clock.ts\` and \`test/login.test.ts\`.`,
    summary:
      'Looking for why the login test fails only on CI, starting with where the clock is read.',
  },
  {
    raw: `测试文件把 TTL 设成了一秒，用来覆盖过期的情况，这就解释得通了：签发时读一次时钟，校验时再读一次，CI 机器慢的时候两次读数之间可能隔了不止一秒，令牌就被判成过期。本地机器快，两次读数几乎同时，所以复现不了。修法有两种：一是给过期判断留一点余量，但这只是把问题藏起来；二是在请求入口只读一次时钟，把同一个时间传给签发和校验。第二种更可靠，测试里也能直接用假时钟。还要确认 \`refresh\` 会不会受影响：它自己调用 \`validate\`，所以也要接收传进来的时间，默认值保持 \`Date.now()\`，已有的调用方就不用改。`,
    summary: '测试把 TTL 设成了一秒，签发和校验各读一次时钟。改成在请求入口只读一次。',
  },
  {
    raw: `The edit is in. Now the regression test: it should fail on the old code and pass on the new one. With fake timers I can freeze time at 1,999 ms, issue the token, then move the clock to 2,000 ms before validating. On the old code \`validate\` reads the new time and, with a one-second TTL, sees the token as expired; on the new code the caller passes the same \`now\` to both, so it stays valid. Nothing in the test may touch the real clock, so \`vi.useFakeTimers({ now: 1_999 })\` and \`vi.setSystemTime(2_000)\`, with \`vi.useRealTimers()\` in \`afterEach\` so the other tests are not affected. Is there a caller that really wants the second read? \`refresh\` validates an older token, and there the token's own issue time matters, not the request's, so passing the request's \`now\` is still right. The default parameter \`now = Date.now()\` is evaluated at call time, so callers that leave it out behave exactly as before. Then run the login and clock tests together, since the flake involved both files, and run them a few times so a pass is stable rather than lucky.`,
    summary: 'Writing a fake-timer test that fails on the old code, then running both test files.',
  },
]

export const SHORT_THOUGHTS = [
  '`refresh` calls `validate` too, so it needs the same timestamp.',
  'Both test files pass three times in a row.',
]

export const REASONING_MESSAGES = [
  'The clock is read once per request now. Next, a regression test that freezes time.',
  'Done: each request reads the clock once, and a fake-timer test guards it. The login and clock tests pass.',
]

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

/** The closing report of the work-report scenario: Chinese prose, chips, inline code and lists. */
export const REPORT_ANSWER = `登录测试偶发失败的问题修好了，开了 draft PR：https://github.com/acme/demo/pull/57 。原因是签发令牌和校验令牌各读了一次时钟，CI 机器慢的时候两次读数会跨过整秒，详细过程记在 https://github.com/acme/demo/issues/56#issuecomment-1 。

## 做了什么

- **只读一次时钟**：\`issueToken\` 和 \`validate\` 都改成接收同一个 \`now\`，默认值仍是 \`Date.now()\`，已有的调用方不用改。
  - \`refresh\` 原来自己再读一次时钟，现在沿用请求开始时的时间。
  - 读时钟集中到 \`src/login.ts\` 一处，测试里可以替换。
- **回归测试**：
  - 用假计时器冻结时间，覆盖整秒边界、时钟回拨和并发请求三种情况。
  - 在 CI 上连续跑了 50 次，没有再失败。

还没做的：\`src/session.ts\` 里还有一处直接读 \`Date.now()\`，和这次的问题无关，先不动，等你确认。
`

// The five tables tables checks: a long one, a wide one with a long note, one of long paths and a
// URL, one with many columns, and one in Chinese. Together they cover a table taller than its
// column, one wider than the whole words have room for, and one too wide for any fitting.
export const TABLES_REPLY = `## Table fitting

A long table, taller than any cap it used to be cut at:

| # | File | Change | Risk |
| --- | --- | --- | --- |
${Array.from(
  { length: 25 },
  (_, i) =>
    `| ${i + 1} | \`src/renderer/features/session/markdown/chunks-${i + 1}.ts\` | Read the clock once in step ${i + 1} | Low |`,
).join('\n')}

Seven columns of short values and a long note:

| Area | Owner | State | Tests | Coverage | Since | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Renderer | Mira | Done | 312 | 87% | 2026-10-01 | The table shares out its extra width by content, so the note takes the room the short columns leave. |
| Agent host | Tomás | In review | 148 | 91% | 2026-09-18 | The session model keeps every page it loaded, and the host replays the rest. |
| Terminal host | Priya | Done | 64 | 78% | 2026-08-22 | Each shell lives in its own process, so a crash takes one tab. |

Long paths and a URL, which have no whole words to keep:

| Module | Path | Link |
| --- | --- | --- |
| Chunks | \`src/renderer/src/features/session/markdown/chunks.ts\` | https://github.com/KettuAI/Kettu/blob/main/src/renderer/src/features/session/markdown/chunks.ts |
| Table fit | \`src/renderer/src/features/session/markdown/table-fit.ts\` | https://github.com/KettuAI/Kettu/blob/main/src/renderer/src/features/session/markdown/table-fit.ts |

Nine columns of numbers:

| Day | Sessions | Turns | Tokens in | Tokens out | Cache read | Cache write | Cost | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Mon | 12 | 84 | 184,320 | 21,760 | 512,000 | 38,400 | $1.42 | 1 |
| Tue | 15 | 96 | 201,984 | 24,512 | 594,432 | 41,216 | $1.61 | 0 |
| Wed | 9 | 61 | 142,080 | 18,304 | 448,128 | 30,208 | $1.13 | 2 |

Chinese headers, which never break between their characters:

| 文件 | 改动 | 说明 | 风险 |
| --- | --- | --- | --- |
| \`src/auth/token.ts\` | 签发和校验都改为接收 \`now\` | 在请求入口只读一次时钟，把同一个时间传给两个函数 | 低 |
| \`src/middleware/session.ts\` | 在入口处读取一次时钟 | 已经有七个调用方一并更新 | 低 |
`

// The reply content scenario plays: every kind of text and block an agent's reply can hold.
export const CONTENT_TEXT = `# 为什么同一天出现了两次

问题出在 \`dayKey()\`：它用 **UTC** 生成日期，而图表按*本地日期*分组。跨过零点的会话因此被算进了两天。旧的写法 ~~toISOString().slice(0, 10)~~ 已经删掉。

## 改了什么

三处改动，都在 usage 模块里。

### 后续

weekly 视图用的是同一个函数，这次一起修好了。

> 图表应该按用户所在时区分组，而不是服务器时区。

---

**无序**

- dayKey() 改成按本地日期
- 新增跨时区测试
  - 覆盖 UTC+8 和 UTC−5
  - 覆盖夏令时切换那天

**有序**

1. 读 usage-store.ts
2. 找出所有调用 dayKey 的地方
3. 改完跑一遍测试

**任务**

- [x] 修复 dayKey
- [x] 补测试
- [ ] 更新 changelog

链接前面带上网站的图标：写法见 [date-fns 的 format 文档](https://date-fns.org/docs/format)。裸地址显示完整域名、路径变灰：https://github.com/KettuAI/Kettu/pull/482 ；本地地址用会话浏览器的图标：http://localhost:5173/usage ；打开过的站点用它自己的图标：https://docs.kettu.sh/remote 。

表格放进细边框容器里；数字列右对齐、等宽数字；悬停整行变浅灰。

| 函数 | 文件 | 新增 | 删除 | 状态 |
| --- | --- | --- | --- | --- |
| \`dayKey\` | src/usage/usage-store.ts | +12 | −4 | 已修复 |
| \`weekKey\` | src/usage/usage-store.ts | +6 | −2 | 已修复 |
| \`UsagePage\` | src/usage/UsagePage.tsx | +2 | −2 | 无需改动 |
| \`day-key.test\` | src/usage/day-key.test.ts | +34 | −0 | 新增 |

行内公式和文字同一行高：缓存命中时，每个 token 的成本约为 $$c_{hit} \\approx 0.1 \\cdot c$$，节省比例是 $$1 - r$$。

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

$$
T = \\sum_{d=1}^{7} t_d \\cdot (1 - r_d)
$$

$$
a + \\notacommand{b}
$$
`

export const CONTENT_BLOCKS = `代码块：文件名或语言在左，换行和复制在右；超过 20 行默认折叠。

\`\`\`ts src/usage/day-key.ts
// Group events by the local day they happened
import { format } from 'date-fns'

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return format(d, 'yyyy-MM-dd')
}
${Array.from({ length: 38 }, (_, i) => `export const day${i + 1} = dayKey(${i + 1} * 86_400_000)`).join('\n')}
\`\`\`

\`\`\`svg weekly-bars.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120" width="300" height="120">
  <title>Weekly bars</title>
  <rect x="20" y="70" width="34" height="30" rx="3" fill="#2a78d6"/>
  <rect x="66" y="50" width="34" height="50" rx="3" fill="#2a78d6"/>
  <rect x="112" y="30" width="34" height="70" rx="3" fill="#2a78d6"/>
  <rect x="158" y="58" width="34" height="42" rx="3" fill="#2a78d6"/>
  <rect x="204" y="20" width="34" height="80" rx="3" fill="#eb6834"/>
</svg>
\`\`\`

\`\`\`mermaid
flowchart LR
  Event --> dayKey["dayKey()"] --> Bucket --> Chart
\`\`\`
`

export const CONTENT_PASSING = `\u001b[32m✓\u001b[39m src/usage/day-key.test.ts \u001b[2m(6 tests)\u001b[22m 41ms
\u001b[32m✓\u001b[39m src/usage/usage-store.test.ts \u001b[2m(12 tests)\u001b[22m 88ms

 \u001b[1mTest Files\u001b[22m  \u001b[32m2 passed\u001b[39m (2)
      \u001b[1mTests\u001b[22m  \u001b[32m18 passed\u001b[39m (18)
`

export const CONTENT_FAILING = `Exit code 1
${Array.from({ length: 143 }, (_, i) => `  running case ${i + 1}`).join('\n')}
\u001b[31m✗\u001b[39m e2e/usage.spec.ts › shows one bar per day

  Expected: \u001b[32m7\u001b[39m
  Received: \u001b[31m8\u001b[39m

  \u001b[2mat e2e/usage.spec.ts:24:31\u001b[22m
`

export const CONTENT_OLD = `export function weekKey(ts: number) {
  const d = new Date(ts)
  return d.getFullYear()
}

// Group events by the day they happened
export function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}
`

export const CONTENT_NEW = `export function weekKey(ts: number) {
  const d = new Date(ts)
  return d.getFullYear()
}

// Group events by the day they happened
export function dayKey(ts: number) {
  const d = new Date(ts)
  return format(d, 'yyyy-MM-dd')
}
`

// The media scenario's reply: pictures, a video and a file that cannot play, which it expects in
// the project's `media` folder; any that is missing shows as such.
export const MEDIA_REPLY = `修复后的 Usage 页：

![Usage 页修复后的截图](./media/usage-page.png)

检查过的几个界面：

![Light](./media/light.png) ![Dark](./media/dark.png) ![Table](./media/table.png) ![Diagrams](./media/diagrams.png) ![Maths](./media/maths.png)

日期选择器的录屏：

![](./media/screen-recording.mp4)

原始录制文件这里放不了：

![](./media/capture.mkv)
`
