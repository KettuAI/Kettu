// Answers Kettu's request for a draft of a problem report's description as a model would: a
// sentence naming the agent and the error, after a wait, so the dialog
// shows the draft being written. `/garbage` in the error answers with an empty block.

import type { StopReason } from '@agentclientprotocol/sdk/unstable'
import type { Turn } from './turn.ts'

export const isReportDraftPrompt = (text: string): boolean =>
  text.startsWith('A user of Kettu, a desktop app for coding agents, is reporting a problem')

function section(text: string, tag: string): string | null {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null
}

export async function reportDraft(turn: Turn): Promise<StopReason> {
  await turn.sleep(1_500)
  if (turn.signal.aborted) return 'cancelled'
  const error = section(turn.text, 'error')
  const shown = error?.split('\n').join(' ') ?? null
  const agent = section(turn.text, 'agent')
  const chinese = /BCP 47 tag zh/.test(turn.text)
  const failed = chinese
    ? agent
      ? `${agent} 会话里出了问题。`
      : 'Kettu 里出了问题。'
    : agent
      ? `Something went wrong in my ${agent} session.`
      : 'Something went wrong in Kettu.'
  const said = !shown ? '' : chinese ? `Kettu 显示：“${shown}”。` : ` Kettu showed: "${shown}".`
  const draft = error?.includes('/garbage') ? '' : failed + said
  await turn.send({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `\`\`\`text\n${draft}\n\`\`\`` },
  })
  return 'end_turn'
}
