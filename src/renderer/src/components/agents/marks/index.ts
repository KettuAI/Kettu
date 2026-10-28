import type { ComponentType } from 'react'
import type { AgentId } from '@shared/thread'
import * as agoragentic from './agoragentic'
import * as amp from './amp'
import * as auggie from './auggie'
import * as autohand from './autohand'
import * as claudeCode from './claude-code'
import * as codebuddy from './codebuddy'
import * as codex from './codex'
import * as cursor from './cursor'
import * as deepagents from './deepagents'
import * as dimcode from './dimcode'
import * as dirac from './dirac'
import * as fakeAgent from './fake-agent'
import * as glm from './glm'
import * as goose from './goose'
import * as kilo from './kilo'
import * as kimi from './kimi'
import * as nova from './nova'
import * as opencode from './opencode'
import * as pi from './pi'
import * as qoder from './qoder'
import * as sigit from './sigit'

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
  auggie,
  codebuddy,
  deepagents,
  dimcode,
  dirac,
  glm,
  nova,
  qoder,
  sigit,
  agoragentic,
  autohand,
  cursor,
  kimi,
  amp,
  goose,
  kilo,
  'fake-agent': fakeAgent,
}
