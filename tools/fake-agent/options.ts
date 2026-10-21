// Scenario selection and options, from the prompt text and the environment.

export const SCENARIOS = [
  'basic-turn',
  'long-stream',
  'tool-storm',
  'permission',
  'parallel-permissions',
  'cancel',
  'crash',
  'auth-required',
  'large-history',
  'slow-start',
  'all-updates',
  'subagent',
  'plan',
  'thinking',
] as const

export type ScenarioName = (typeof SCENARIOS)[number]

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, { description: string; hint?: string }> = {
  'basic-turn': { description: 'A short answer with markdown and one edit with a diff' },
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
  crash: { description: 'Exits mid-turn with a non-zero code', hint: '--code <n>' },
  'auth-required': { description: 'Signs the agent out; requests fail until you sign in' },
  'large-history': { description: 'Makes reopening this session replay 1,000 entries' },
  'slow-start': { description: 'Explains how to start the agent slowly (set at launch)' },
  'all-updates': { description: 'Sends every session update variant once, plus an unknown one' },
  subagent: { description: 'Runs a subagent in a child session with a permission request' },
  plan: { description: 'A plan whose items progress while the agent works' },
  thinking: { description: 'A long thought, then an answer' },
}

export interface ScenarioOptions {
  rate: number // updates per second, for long-stream
  size: number // bytes, for long-stream
  count: number // tool calls, for tool-storm
  ignoreCancel: boolean
  withdrawMs: number | null // permission: withdraw the request after this long
  exitCode: number
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
  }
  return { scenario, options, text }
}

/** Multiplies every delay; 0 runs scenarios as fast as possible, for tests. */
export function delayScale(env: Env): number {
  return parseNumber(env.FAKE_AGENT_DELAY_SCALE) ?? 1
}
