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
  'sigit',
  'agoragentic',
  'autohand',
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
  'harn',
  'kimchi',
  'antigravity',
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
export const MULTI_AGENT_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex']

/**
 * Harnesses whose default agent is registered without being added. Only the fake agent, which
 * exists in development builds, so the tools that drive the app have an agent to use.
 */
export const AUTO_AGENT_HARNESSES: readonly HarnessId[] = ['fake-agent']

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
export const START_MODE_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex']

/** The permission modes that never ask, which no setting may start a session in. */
export const FULL_ACCESS_MODES: readonly string[] = [
  'bypassPermissions',
  'agent-full-access',
  'danger-full-access',
]

export function isFullAccessMode(value: string | undefined): boolean {
  return value !== undefined && FULL_ACCESS_MODES.includes(value)
}

/** The longest mode id a start mode may name. */
export const START_MODE_CHARS = 64

export function takesStartMode(id: AgentId): boolean {
  return START_MODE_HARNESSES.includes(harnessOf(id))
}

/** Whether `value` can be the agent's start mode: any mode id but one that gives full access. */
export function isStartMode(id: AgentId, value: unknown): value is string {
  return (
    takesStartMode(id) &&
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= START_MODE_CHARS &&
    !isFullAccessMode(value)
  )
}

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
