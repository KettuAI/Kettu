// The agents OverBench knows, so every list of them names the ids in one place.

export type AgentId =
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
  | 'cursor'
  | 'kimi'
  | 'amp'
  | 'goose'
  | 'kilo'
  | 'fake-agent'

export const AGENT_IDS: readonly AgentId[] = [
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
  'cursor',
  'kimi',
  'amp',
  'goose',
  'kilo',
  'fake-agent',
]
