import type { AgentColor } from '@shared/settings'
import { harnessOf, type AgentId, type HarnessId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import type { ModelRead } from './model-list'

// The vendors whose marks the app has, by the words their models' names and ids carry, each with
// its own agents, the main one first: OpenAI's models take Codex's mark and Google's Antigravity's.
// DeepSeek comes before OpenAI, since a route's name can end in "Codex".
const VENDORS: [RegExp, readonly HarnessId[]][] = [
  [/claude|\bfable\b|\bopus\b|\bsonnet\b|\bhaiku\b/i, ['claude-code']],
  [/deepseek/i, ['deepseek']],
  [/gemini|gemma/i, ['antigravity', 'gemini']],
  [/kimi|moonshot/i, ['kimi']],
  [/\bglm|zhipu/i, ['glm']],
  [/grok/i, ['grok']],
  [/minimax/i, ['minimax']],
  [/qwen/i, ['qwen']],
  [/mistral|devstral|codestral|magistral/i, ['mistral-vibe']],
  [/\bmuse\b/i, ['muse']],
  [/gpt|openai|codex|\bo[1-9]\b|\bastra\b|\bsol\b|\bterra\b|\bluna\b/i, ['codex']],
]

/**
 * The harness whose mark is the model's vendor's, by its name, else its id: the session's own when
 * it is one of the vendor's agents, else the vendor's main one; null for unknown.
 */
function vendorOf(read: ModelRead, agentId: AgentId): HarnessId | null {
  const name = read.name.split(/\s+[·(]/)[0]!
  const id = read.choice.modelId ?? read.value
  const own = harnessOf(agentId)
  for (const text of [name, id]) {
    const agents = VENDORS.find(([pattern]) => pattern.test(text))?.[1]
    if (agents) return agents.includes(own) ? own : agents[0]!
  }
  return null
}

/**
 * A model's mark: its vendor's, else the agent's own. Rows draw it without a dot; the model button
 * passes the agent's dot, which tells the accounts of one harness apart.
 */
export function ModelMark({
  read,
  agentId,
  size = 16,
  dot = null,
  className,
}: {
  read: ModelRead | null
  agentId: AgentId
  size?: number
  dot?: AgentColor | null
  className?: string
}) {
  const vendor = read ? vendorOf(read, agentId) : null
  return <AgentMark agent={vendor ?? agentId} size={size} dot={dot} className={className} />
}
