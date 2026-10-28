// The agents OverBench knows, so every list of them names the ids in one place.

export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'fake-agent'

export const AGENT_IDS: readonly AgentId[] = [
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'fake-agent',
]
