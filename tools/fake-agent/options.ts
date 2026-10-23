// Scenario selection and options, from the prompt text and the environment.

export const SCENARIOS = [
  'basic-turn',
  'long-stream',
  'tool-storm',
  'permission',
  'parallel-permissions',
  'cancel',
  'long-turn',
  'crash',
  'error',
  'auth-required',
  'large-history',
  'slow-start',
  'all-updates',
  'subagent',
  'plan',
  'background',
  'requests',
  'thinking',
  'svg',
  'usage',
  'status',
  'context',
  'recall',
  'chinese',
] as const

export type ScenarioName = (typeof SCENARIOS)[number]

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, { description: string; hint?: string }> = {
  'basic-turn': {
    description: 'A short answer with markdown, then reads, an edit, a new file and a test run',
  },
  'long-stream': {
    description: '200 KB of markdown in small chunks',
    hint: '--rate <updates per second> --size <bytes, such as 200k>',
  },
  'tool-storm': { description: '500 tool calls with updates for each', hint: '--count <n>' },
  permission: {
    description: 'A command that needs approval, with all four option kinds',
    hint: '--withdraw <ms>',
  },
  'parallel-permissions': { description: 'Three tool calls asking for permission at once' },
  cancel: { description: 'A long turn that honors cancellation', hint: '--ignore-cancel' },
  'long-turn': {
    description: 'Thinks, reads, runs commands and edits until you cancel, as the context grows',
  },
  crash: { description: 'Exits mid-turn with a non-zero code', hint: '--code <n>' },
  error: { description: 'Fails the turn with an internal error' },
  'auth-required': {
    description: 'Signs the agent out; requests fail until you sign in, then the retry answers',
  },
  'large-history': {
    description: 'Makes reopening this session replay 1,000 entries',
    hint: '--entries <n>',
  },
  'slow-start': { description: 'Explains how to start the agent slowly (set at launch)' },
  'all-updates': { description: 'Sends every session update variant once, plus an unknown one' },
  subagent: { description: 'Runs a subagent in a child session with a permission request' },
  plan: {
    description: 'A plan whose items progress while the agent works',
    hint: '--step <ms each step takes>',
  },
  background: {
    description: 'Starts a command in the background, as Claude Code does with run_in_background',
  },
  requests: {
    description: "Reports a request's usage as claude-agent-acp does, then the result's",
    hint: '--hold <ms before the turn ends> --then <ms until it answers by itself> --at-end',
  },
  thinking: { description: 'A long thought, then an answer' },
  svg: { description: 'A reply with svg code blocks: a diagram, a badge and bare path data' },
  usage: {
    description: "The plan limits, as Claude Code's /usage reports them",
    hint: '--plain',
  },
  status: { description: "The plan limits, as Codex's /status reports them" },
  context: { description: "What fills the context, as Claude Code's /context reports it" },
  recall: { description: 'Answers with your previous message, as the agent remembers it' },
  chinese: { description: 'A long answer in Chinese, with every Markdown block' },
}

export interface ScenarioOptions {
  rate: number // updates per second, for long-stream
  size: number // bytes, for long-stream
  count: number // tool calls, for tool-storm
  ignoreCancel: boolean
  withdrawMs: number | null // permission: withdraw the request after this long
  exitCode: number
  entries: number // large-history: the entries its replay synthesizes
  plain: boolean // usage: Claude Code's own text, as the adapter forwards it when its report fails
  stepMs: number // plan: how long each step's tool call runs
  holdMs: number // requests: how long the turn stays open after its request, not scaled
  thenMs: number | null // requests: when it answers by itself after the turn, not scaled
  atEnd: boolean // requests: usage only as the turn ends, as OpenCode reports it
}

export interface ScenarioChoice {
  scenario: ScenarioName | 'compact'
  options: ScenarioOptions
  text: string // the prompt without the command
}

export type Env = Record<string, string | undefined>

function isScenario(name: string): name is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(name)
}

function parseSize(value: string | undefined): number | null {
  if (!value) return null
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/i.exec(value.trim())
  if (!match) return null
  const unit = match[2]!.toLowerCase()
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1
  return Math.round(Number(match[1]) * factor)
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === `--${name}`) {
      const next = args[i + 1]
      return next !== undefined && !next.startsWith('--') ? next : ''
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

/**
 * `/scenario <name> [--flags]` or `/<name> [--flags]` picks a scenario; any other text runs
 * the default, `FAKE_AGENT_SCENARIO` or `basic-turn`. Flags override the environment.
 */
export function chooseScenario(prompt: string, env: Env): ScenarioChoice {
  const trimmed = prompt.trim()
  const words = trimmed.split(/\s+/)
  let scenario: ScenarioName | 'compact' | null = null
  let args: string[] = []
  let text = trimmed
  const first = words[0] ?? ''
  if (first === '/scenario' && words[1] && isScenario(words[1])) {
    scenario = words[1]
    args = words.slice(2)
    text = ''
  } else if (first.startsWith('/')) {
    const name = first.slice(1)
    if (isScenario(name) || name === 'compact') {
      scenario = name
      args = words.slice(1)
      text = ''
    }
  }
  if (!scenario) {
    const fallback = env.FAKE_AGENT_SCENARIO
    scenario = fallback && isScenario(fallback) ? fallback : 'basic-turn'
  }

  const withdraw = flagValue(args, 'withdraw')
  const options: ScenarioOptions = {
    rate: parseNumber(flagValue(args, 'rate')) || parseNumber(env.FAKE_AGENT_RATE) || 200,
    size: parseSize(flagValue(args, 'size')) ?? parseSize(env.FAKE_AGENT_SIZE) ?? 200 * 1024,
    count: parseNumber(flagValue(args, 'count')) ?? parseNumber(env.FAKE_AGENT_COUNT) ?? 500,
    ignoreCancel:
      flagValue(args, 'ignore-cancel') !== undefined || env.FAKE_AGENT_IGNORE_CANCEL === '1',
    withdrawMs: withdraw === undefined ? null : withdraw === '' ? 1500 : parseNumber(withdraw),
    exitCode: parseNumber(flagValue(args, 'code')) ?? 3,
    entries: historyEntries(env, parseNumber(flagValue(args, 'entries'))),
    plain: flagValue(args, 'plain') !== undefined,
    stepMs: parseNumber(flagValue(args, 'step')) ?? 300,
    holdMs: parseNumber(flagValue(args, 'hold')) ?? 0,
    thenMs: parseNumber(flagValue(args, 'then')),
    atEnd: flagValue(args, 'at-end') !== undefined,
  }
  return { scenario, options, text }
}

/** The size of a large-history replay: the flag, else `FAKE_AGENT_HISTORY_ENTRIES`, else 1,000. */
export function historyEntries(env: Env, flag: number | null = null): number {
  return flag || parseNumber(env.FAKE_AGENT_HISTORY_ENTRIES) || 1000
}

/** Multiplies every delay; 0 runs scenarios as fast as possible, for tests. */
export function delayScale(env: Env): number {
  return parseNumber(env.FAKE_AGENT_DELAY_SCALE) ?? 1
}
