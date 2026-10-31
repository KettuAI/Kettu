import type { ComponentType } from 'react'
import type { HarnessId } from '@shared/thread'
import * as agoragentic from './agoragentic'
import * as amp from './amp'
import * as antigravity from './antigravity'
import * as auggie from './auggie'
import * as autohand from './autohand'
import * as bob from './bob'
import * as claudeCode from './claude-code'
import * as cline from './cline'
import * as codebuddy from './codebuddy'
import * as codewhale from './codewhale'
import * as codex from './codex'
import * as copilot from './copilot'
import * as cursor from './cursor'
import * as cortexCode from './cortex-code'
import * as corustAgent from './corust-agent'
import * as crowCli from './crow-cli'
import * as deepagents from './deepagents'
import * as devin from './devin'
import * as dimcode from './dimcode'
import * as dirac from './dirac'
import * as droid from './droid'
import * as fakeAgent from './fake-agent'
import * as fastAgent from './fast-agent'
import * as gemini from './gemini'
import * as glm from './glm'
import * as goose from './goose'
import * as grok from './grok'
import * as harn from './harn'
import * as hermes from './hermes'
import * as kilo from './kilo'
import * as kimchi from './kimchi'
import * as kimi from './kimi'
import * as minimax from './minimax'
import * as minion from './minion'
import * as muse from './muse'
import * as junie from './junie'
import * as mistralVibe from './mistral-vibe'
import * as nova from './nova'
import * as omp from './omp'
import * as opencode from './opencode'
import * as pi from './pi'
import * as poolside from './poolside'
import * as qoder from './qoder'
import * as qwen from './qwen'
import * as sigit from './sigit'
import * as stakpak from './stakpak'
import * as vtcode from './vtcode'

export interface MarkBodyProps {
  mono: boolean
}

/** One agent's mark: its viewBox and what it draws. */
export interface AgentMarkModule {
  viewBox: string
  Body: ComponentType<MarkBodyProps>
}

/** One line per agent; the agent's own colors stay in its module. */
export const AGENT_MARKS: Record<HarnessId, AgentMarkModule> = {
  'claude-code': claudeCode,
  cline,
  codex,
  copilot,
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
  qwen,
  sigit,
  agoragentic,
  autohand,
  bob,
  minimax,
  cursor,
  kimi,
  amp,
  goose,
  grok,
  kilo,
  harn,
  kimchi,
  droid,
  gemini,
  omp,
  hermes,
  muse,
  codewhale,
  antigravity,
  devin,
  'cortex-code': cortexCode,
  'corust-agent': corustAgent,
  'crow-cli': crowCli,
  junie,
  'mistral-vibe': mistralVibe,
  poolside,
  stakpak,
  vtcode,
  'fast-agent': fastAgent,
  minion,
  'fake-agent': fakeAgent,
}
