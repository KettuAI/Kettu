// Messages between main and the two utility processes, over `utilityProcess` messaging.

import type { Platform } from './platform'
import type { HostSettings, TerminalSettings } from './settings'
import type { AgentId } from './thread'

export interface BusySession {
  sessionId: string
  agentId: AgentId
  title: string | null
}

export interface BusyTerminal {
  id: string
  projectPath: string
  title: string // the foreground command
}

export type MainToHost =
  | {
      type: 'host:init'
      userDataPath: string
      appVersion: string
      platform: Platform
      isPackaged: boolean
      electronPath: string // runs as Node.js with ELECTRON_RUN_AS_NODE, for the shell probe
      fakeAgentPath: string | null // tools/fake-agent/main.ts in development, or from OVERBENCH_FAKE_AGENT
      settings: HostSettings
    }
  | { type: 'host:connect'; windowId: number } // the port travels in the transfer list
  | { type: 'host:settings'; settings: HostSettings }
  | { type: 'host:busy-request'; requestId: number }
  | { type: 'host:shutdown' }

export type HostToMain =
  | { type: 'host:ready' }
  | { type: 'host:agent-processes'; processes: { agentId: AgentId; pid: number }[] }
  | { type: 'host:projects'; paths: string[] }
  | { type: 'host:auth-commands'; commands: string[] } // terminal sign-in commands it built
  | {
      type: 'host:attention'
      sessionId: string
      kind: 'permission' | 'turn-ended' | 'error'
      title: string
      body: string
    }
  | { type: 'host:badge'; count: number } // pending permission requests across sessions
  | { type: 'host:busy'; requestId: number; sessions: BusySession[] }
  | { type: 'host:log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'host:stopped' }

export type MainToTerminalHost =
  | {
      type: 'terminal-host:init'
      platform: Platform
      appVersion: string
      settings: TerminalSettings
      projects: string[]
      authCommands: string[]
    }
  | { type: 'terminal-host:connect'; windowId: number } // the port travels in the transfer list
  | { type: 'terminal-host:settings'; settings: TerminalSettings }
  | { type: 'terminal-host:projects'; paths: string[] }
  | { type: 'terminal-host:auth-commands'; commands: string[] }
  | { type: 'terminal-host:busy-request'; requestId: number }
  | { type: 'terminal-host:shutdown' }

export type TerminalHostToMain =
  | { type: 'terminal-host:ready' }
  | { type: 'terminal-host:busy'; requestId: number; terminals: BusyTerminal[] }
  | { type: 'terminal-host:stopped' }
