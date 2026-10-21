import { describe, expect, it } from 'vitest'
import { parseContextReport, parseResetTime, parseUsageReport } from './claude-reports'

// The adapter's reports as a Claude Max account produced them on 2026-10-21, trimmed.
const USAGE = `## Usage

> Claude max subscription usage

### Limits

**5-hour limit** — **45%** · Resets Oct 21, 3:00 PM PDT

\`█████████░░░░░░░░░░░\`

**Weekly · all models** — **54%** · Resets Oct 24, 6:00 AM PDT

\`███████████░░░░░░░░░\`

**Weekly · Fable** — **7%** · Resets Oct 24, 5:59 AM PDT

\`█░░░░░░░░░░░░░░░░░░░\`

---

### This session

| Cost | API time | Active |
|:--|:--|:--|
| $0.00 | 0s | 6s |

---

### What’s using your limits?

**Last 24h** · 7134 requests · 16 sessions

| MCP server | Usage |
|:--|--:|
| ccd\\_turn | \`█░░░░░░░░░░░░░░░░░░░\` 5% |`

const CONTEXT = `## Context Usage

**Model:** claude-fable-5-1
**Tokens:** 32.1k / 600k (5%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.6k | 0.8% |
| System tools | 12.2k | 2.0% |
| MCP tools | 671 | 0.1% |
| MCP tools (deferred) | 1.4k | 0.2% |
| Memory files | 3.6k | 0.6% |
| Skills | 9.5k | 1.6% |
| Messages | 750 | 0.1% |
| Free space | 534.9k | 89.2% |
| Autocompact buffer | 33k | 5.5% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__docs__read | docs | 324 |
| mcp__docs__update | docs | 298 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | /home/me/.claude/CLAUDE.md | 3.6k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| frontend-design | User | ~70 |
| init | Built-in | < 20 |`

const NOW = new Date(2026, 9, 21, 12, 0).getTime()

describe('parseUsageReport', () => {
  it('reads every limit with its use and reset', () => {
    expect(parseUsageReport(USAGE, NOW)).toEqual([
      {
        window: 'five_hour',
        label: '5-hour',
        usedPercent: 45,
        resetsAt: new Date(2026, 9, 21, 15, 0).getTime(),
        state: 'ok',
        observedAt: NOW,
      },
      {
        window: 'seven_day',
        label: 'Weekly',
        usedPercent: 54,
        resetsAt: new Date(2026, 9, 24, 6, 0).getTime(),
        state: 'ok',
        observedAt: NOW,
      },
      {
        window: 'seven_day_fable',
        label: 'Weekly · Fable',
        usedPercent: 7,
        resetsAt: new Date(2026, 9, 24, 5, 59).getTime(),
        state: 'ok',
        observedAt: NOW,
      },
    ])
  })

  it('names the Opus and Sonnet windows as the rate-limit events do', () => {
    const report = '## Usage\n\n### Limits\n\n**Weekly · Opus** — **100%**\n'
    expect(parseUsageReport(report, NOW)).toEqual([
      expect.objectContaining({
        window: 'seven_day_opus',
        label: 'Weekly · Opus',
        usedPercent: 100,
        resetsAt: null,
        state: 'reached',
      }),
    ])
  })

  it('gives no limits for an account without them, and null for other text', () => {
    expect(parseUsageReport('## Usage\n\n---\n\n### This session\n', NOW)).toEqual([])
    expect(parseUsageReport('Current session: 45% used', NOW)).toBeNull()
  })
})

describe('parseResetTime', () => {
  it('applies a GMT offset as written', () => {
    expect(parseResetTime('Oct 22, 6:00 AM GMT+8', NOW)).toBe(Date.UTC(2026, 9, 21, 22, 0))
    expect(parseResetTime('Oct 22, 6:00 AM GMT+5:30', NOW)).toBe(Date.UTC(2026, 9, 22, 0, 30))
    expect(parseResetTime('Oct 22, 12:15 PM UTC', NOW)).toBe(Date.UTC(2026, 9, 22, 12, 15))
  })

  it('reads the narrow space newer ICU puts before AM and PM', () => {
    expect(parseResetTime('Oct 21, 12:30\u202fAM PDT', NOW)).toBe(
      new Date(2026, 9, 21, 0, 30).getTime(),
    )
  })

  it('moves a reset early in the year into the next one', () => {
    const december = new Date(2026, 11, 30, 12, 0).getTime()
    expect(parseResetTime('Jan 2, 9:00 AM PST', december)).toBe(new Date(2027, 0, 2, 9).getTime())
  })

  it('gives null for text in another shape', () => {
    expect(parseResetTime('in 3 hours', NOW)).toBeNull()
  })
})

describe('parseContextReport', () => {
  it('reads the totals, the categories and the lists', () => {
    const breakdown = parseContextReport(CONTEXT, NOW)
    expect(breakdown).toMatchObject({
      model: 'claude-fable-5-1',
      used: 32_100,
      size: 600_000,
      observedAt: NOW,
    })
    expect(breakdown?.categories.slice(0, 3)).toEqual([
      { name: 'System prompt', tokens: 4_600, share: 0.008 },
      { name: 'System tools', tokens: 12_200, share: 0.02 },
      { name: 'MCP tools', tokens: 671, share: 0.001 },
    ])
    expect(breakdown?.categories.at(-1)).toEqual({
      name: 'Autocompact buffer',
      tokens: 33_000,
      share: 0.055,
    })
    expect(breakdown?.lists).toEqual([
      {
        name: 'MCP Tools',
        items: [
          { name: 'mcp__docs__read', detail: 'docs', tokens: '324' },
          { name: 'mcp__docs__update', detail: 'docs', tokens: '298' },
        ],
      },
      {
        name: 'Memory Files',
        items: [{ name: 'User', detail: '/home/me/.claude/CLAUDE.md', tokens: '3.6k' }],
      },
      {
        name: 'Skills',
        items: [
          { name: 'frontend-design', detail: 'User', tokens: '~70' },
          { name: 'init', detail: 'Built-in', tokens: '< 20' },
        ],
      },
    ])
  })

  it('gives null without the totals or the category table', () => {
    expect(parseContextReport('## Context Usage\n\n**Model:** x\n', NOW)).toBeNull()
    expect(parseContextReport('Context: 5% used', NOW)).toBeNull()
  })
})
