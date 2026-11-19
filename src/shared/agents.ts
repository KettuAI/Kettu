// The harnesses Kettu knows, so every list of them names the ids in one place, and the agents a
// user picks to work with, each a harness with a configuration folder of its own.

export type HarnessId =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'auggie'
  | 'codebuddy'
  | 'deepagents'
  | 'dimcode'
  | 'dirac'
  | 'glm'
  | 'nova'
  | 'qoder'
  | 'qoder-cn'
  | 'sigit'
  | 'agoragentic'
  | 'autohand'
  | 'gemini'
  | 'copilot'
  | 'qwen'
  | 'grok'
  | 'cline'
  | 'droid'
  | 'bob'
  | 'minimax'
  | 'cursor'
  | 'kimi'
  | 'amp'
  | 'goose'
  | 'kilo'
  | 'omp'
  | 'hermes'
  | 'muse'
  | 'codewhale'
  | 'deepseek'
  | 'harn'
  | 'kimchi'
  | 'antigravity'
  | 'devin'
  | 'cortex-code'
  | 'corust-agent'
  | 'crow-cli'
  | 'junie'
  | 'mistral-vibe'
  | 'poolside'
  | 'stakpak'
  | 'vtcode'
  | 'fast-agent'
  | 'minion'
  | 'fake-agent'

export const HARNESS_IDS: readonly HarnessId[] = [
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'auggie',
  'codebuddy',
  'deepagents',
  'dimcode',
  'dirac',
  'glm',
  'nova',
  'qoder',
  'qoder-cn',
  'sigit',
  'agoragentic',
  'autohand',
  'antigravity',
  'gemini',
  'copilot',
  'qwen',
  'grok',
  'cline',
  'droid',
  'bob',
  'minimax',
  'cursor',
  'kimi',
  'amp',
  'goose',
  'kilo',
  'omp',
  'hermes',
  'muse',
  'codewhale',
  'deepseek',
  'harn',
  'kimchi',
  'devin',
  'cortex-code',
  'corust-agent',
  'crow-cli',
  'junie',
  'mistral-vibe',
  'poolside',
  'stakpak',
  'vtcode',
  'fast-agent',
  'minion',
  'fake-agent',
]

/** The harnesses that carry agents besides their default one: a variable moves their folder. */
export const MULTI_AGENT_HARNESSES: readonly HarnessId[] = [
  'claude-code',
  'codex',
  'deepseek',
  'codebuddy',
]

/**
 * The harnesses whose added agents sign in only with an API key: their other sign-ins are kept for
 * the whole computer, outside the agent's folder, so a second agent would share them.
 */
export const KEY_ONLY_ADDED_HARNESSES: readonly HarnessId[] = ['codebuddy']

/**
 * Harnesses whose default agent is registered without being added. Only the fake agent, which
 * exists in development builds, so the tools that drive the app have an agent to use.
 */
export const AUTO_AGENT_HARNESSES: readonly HarnessId[] = ['fake-agent']

/**
 * The harnesses that run the user's own program, in the order a host's first start adds their
 * default agents for the ones it finds. The others are installed by Kettu, so none is found.
 */
export const USER_PROGRAM_HARNESSES: readonly HarnessId[] = [
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'minimax',
  'cursor',
  'kimi',
  'amp',
  'goose',
  'kilo',
  'omp',
  'hermes',
  'muse',
  'codewhale',
  'antigravity',
]

/**
 * An agent: the default one is its harness's own id, so sessions and settings from before agents
 * keep theirs; an added one is `<harness>~<slug>`.
 */
export type AgentId = HarnessId | `${HarnessId}~${string}`

const ADDED_AGENT = /^([a-z][a-z0-9-]*)~([a-z0-9][a-z0-9-]{0,39})$/

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
}

export function isAgentId(value: unknown): value is AgentId {
  if (isHarnessId(value)) return true
  if (typeof value !== 'string') return false
  const harness = ADDED_AGENT.exec(value)?.[1]
  return harness !== undefined && (MULTI_AGENT_HARNESSES as readonly string[]).includes(harness)
}

export function harnessOf(id: AgentId): HarnessId {
  const tilde = id.indexOf('~')
  return (tilde < 0 ? id : id.slice(0, tilde)) as HarnessId
}

export function isDefaultAgent(id: AgentId): id is HarnessId {
  return !id.includes('~')
}

/** The id an added agent gets from its name, unique among `taken`. */
export function addedAgentId(harness: HarnessId, name: string, taken: readonly string[]): AgentId {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'agent'
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    const id = `${harness}~${slug}` as const
    if (!taken.includes(id)) return id
  }
}

/** The harnesses whose agents take a start mode: the permission mode new sessions start in. */
export const START_MODE_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex', 'deepseek']

/** Google Antigravity's full access, Kettu's mode for agy's `--dangerously-skip-permissions`. */
export const ANTIGRAVITY_FULL_ACCESS = 'dangerously-skip-permissions'

/** The permission modes that never ask. */
export const FULL_ACCESS_MODES: readonly string[] = [
  'bypassPermissions',
  'agent-full-access',
  'danger-full-access',
  ANTIGRAVITY_FULL_ACCESS,
]

export function isFullAccessMode(value: string | undefined): boolean {
  return value !== undefined && FULL_ACCESS_MODES.includes(value)
}

/** The longest mode id a start mode may name. */
export const START_MODE_CHARS = 64

export function takesStartMode(id: AgentId): boolean {
  return START_MODE_HARNESSES.includes(harnessOf(id))
}

/** Whether `value` can be the agent's start mode: any mode id, full access included. */
export function isStartMode(id: AgentId, value: unknown): value is string {
  return (
    takesStartMode(id) &&
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= START_MODE_CHARS
  )
}

/** The range in tokens Claude Code accepts for a model's auto-compact window. */
export const AUTO_COMPACT_MIN = 100_000
export const AUTO_COMPACT_MAX = 1_000_000

/** The windows Settings offers beside Auto. */
export const AUTO_COMPACT_STEPS: readonly number[] = [
  100_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
]

export const PROMPT_CACHE_TTLS = ['5m', '1h'] as const
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number]

/** Claude models Settings suggests when a model is added, as Anthropic names them. */
export const KNOWN_CLAUDE_MODELS: readonly { id: string; name: string }[] = [
  { id: 'claude-fable-5-2', name: 'Fable 5.2' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  { id: 'claude-opus-4-7', name: 'Opus 4.7' },
]

/** A model id without its context suffix or date, as Claude Code's `modelSettings` keys it. */
export const canonicalClaudeModel = (id: string): string =>
  id
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase()

/** Whether the agent's page edits Claude Code's common settings, which only its agents have. */
export function takesClaudeSettings(id: AgentId): boolean {
  return harnessOf(id) === 'claude-code'
}

/** Whether the agent signs in only with an API key: an added agent of a harness that says so. */
export function signsInWithKeyOnly(id: AgentId): boolean {
  return !isDefaultAgent(id) && KEY_ONLY_ADDED_HARNESSES.includes(harnessOf(id))
}

/** Whether the agent's page edits which site Codebuddy Code talks to. */
export function takesCodebuddySettings(id: AgentId): boolean {
  return harnessOf(id) === 'codebuddy'
}

/** The variable of Codebuddy Code's settings `env` that picks its site. */
export const CODEBUDDY_SITE_VARIABLE = 'CODEBUDDY_INTERNET_ENVIRONMENT'

/** The sites Settings offers; enterprise, iOA and private deployments are set by hand. */
export const CODEBUDDY_SITES = ['international', 'china'] as const
export type CodebuddySite = (typeof CODEBUDDY_SITES)[number]

/**
 * What the variable holds for each site. The international one is written out, not left unset:
 * an unset variable follows the computer's shared sign-in, which may be on the China site.
 */
export const CODEBUDDY_SITE_VALUES: Record<CodebuddySite, string> = {
  international: 'external',
  china: 'internal',
}

/** Shell variables that Codebuddy Code ranks above the settings Kettu writes. */
export const CODEBUDDY_SHELL_OVERRIDES = ['CODEBUDDY_AUTH_TOKEN', 'WORKBUDDY_CONFIG_DIR'] as const
export type CodebuddyShellOverride = (typeof CODEBUDDY_SHELL_OVERRIDES)[number]

/** Agents in catalog order of their harness, each harness's default agent first. */
export function sortAgentIds<T extends AgentId>(ids: Iterable<T>): T[] {
  const rank = (id: AgentId): number => HARNESS_IDS.indexOf(harnessOf(id))
  return [...new Set(ids)].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(!isDefaultAgent(a)) - Number(!isDefaultAgent(b)) ||
      a.localeCompare(b),
  )
}
