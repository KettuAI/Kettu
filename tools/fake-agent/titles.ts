// Answers OverBench's request for the message outline's titles as a model would: a JSON object of
// each message's first words. A message holding `/permission` asks for a permission first and is
// titled with the answer, `/slow` holds the answer back a while, and `/garbage` answers in prose.

import type { StopReason } from '@agentclientprotocol/sdk/unstable'
import { ALL_PERMISSION_OPTIONS } from './scenarios.ts'
import type { Turn } from './turn.ts'

export const isTitlesPrompt = (text: string): boolean =>
  text.startsWith('Write a title of at most six words for each message below')

export async function titles(turn: Turn): Promise<StopReason> {
  const list = JSON.parse(turn.text.slice(turn.text.indexOf('['))) as { id: string; text: string }[]
  const all = list.map((message) => message.text).join('\n')
  if (all.includes('/slow')) await turn.sleep(500)
  if (turn.signal.aborted) return 'cancelled'
  const answer: Record<string, string> = {}
  for (const { id, text } of list) {
    if (text.includes('/permission')) {
      const outcome = await turn.requestPermission(
        { toolCallId: `titles-${id}`, title: 'Read the project', kind: 'read' },
        ALL_PERMISSION_OPTIONS,
      )
      answer[id] = `Permission ${outcome}`
    } else answer[id] = text.split(/\s+/).slice(0, 3).join(' ')
  }
  const reply = all.includes('/garbage')
    ? 'I would rather not.'
    : `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``
  await turn.send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
  return 'end_turn'
}
