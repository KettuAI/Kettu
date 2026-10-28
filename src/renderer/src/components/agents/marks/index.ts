import type { ComponentType } from 'react'
import type { AgentId } from '@shared/thread'
import * as claudeCode from './claude-code'
import * as codex from './codex'
import * as fakeAgent from './fake-agent'
import * as opencode from './opencode'
import * as pi from './pi'

export interface MarkBodyProps {
  mono: boolean
}

/** One agent's mark: its viewBox and what it draws. */
export interface AgentMarkModule {
  viewBox: string
  Body: ComponentType<MarkBodyProps>
}

/** One line per agent; the agent's own colors stay in its module. */
export const AGENT_MARKS: Record<AgentId, AgentMarkModule> = {
  'claude-code': claudeCode,
  codex,
  opencode,
  pi,
  'fake-agent': fakeAgent,
}
