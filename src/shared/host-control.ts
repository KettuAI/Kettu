// Messages between main and the two utility processes, over `utilityProcess` messaging.

import type { ArtifactImportResult } from './artifacts'
import type { AttachmentGrant } from './attachments'
import type { MediaGrantRecord } from './media'
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
      threadWorkerPath: string // the thread worker's bundle, which main builds beside the host's
      usageWorkerPath: string // the usage worker's bundle, built the same way
      // The session router's bundle, which a per-session agent's process runs under the user's Node.js.
      sessionRouterPath: string
      settings: HostSettings
    }
  | { type: 'host:connect'; windowId: number } // the port travels in the transfer list
  | { type: 'host:settings'; settings: HostSettings }
  | { type: 'host:busy-request'; requestId: number }
  | { type: 'host:grant'; requestId: number; grants: AttachmentGrant[] } // answered by host:granted
  // `artifact.content`: the file of a version, the latest when `version` is null.
  | { type: 'host:artifact-content-request'; requestId: number; id: string; version: number | null }
  // `artifact.list`: the id of every artifact the host has, Recently deleted included.
  | { type: 'host:artifact-list-request'; requestId: number }
  // `artifact.import`: a file the user chose in main's dialog, made an artifact in `project`, or
  // in a new scratch folder when `project` is null.
  | {
      type: 'host:artifact-import-request'
      requestId: number
      path: string
      project: string | null
    }
  | { type: 'host:power'; state: 'suspend' | 'resume' }
  | { type: 'host:shutdown' }

/** The host's answer to `host:artifact-content-request`. */
export type ArtifactContentResult =
  | { kind: 'found'; path: string; version: number; title: string } // `path` lies in artifacts/content/
  | { kind: 'not_found' }
  | { kind: 'failed' }

/** The host's answer to `host:artifact-list-request`. */
export type ArtifactListResult = { kind: 'listed'; ids: string[] } | { kind: 'failed' }

/** An agent process the host runs; its start time tells it apart from a later one with its pid. */
export interface AgentProcess {
  agentId: AgentId
  pid: number
  startedAt: number
}

export type HostToMain =
  | { type: 'host:ready' }
  | { type: 'host:agent-processes'; processes: AgentProcess[] }
  | { type: 'host:projects'; paths: string[] }
  | { type: 'host:auth-commands'; commands: string[] } // terminal sign-in commands it built
  | {
      type: 'host:attention'
      sessionId: string
      kind: 'permission' | 'turn-ended' | 'error' | 'routine-ended'
      title: string
      body: string
    }
  // An agent's routines paused at a plan limit; it has no session and opens the Routines page.
  | {
      type: 'host:attention'
      kind: 'routine-paused'
      agentId: AgentId
      title: string
      body: string
    }
  | { type: 'host:badge'; count: number } // pending permission requests across sessions
  // Whether any routine run is starting or running, for keeping the computer from idle sleep.
  | { type: 'host:routines-working'; working: boolean }
  | { type: 'host:busy'; requestId: number; sessions: BusySession[] }
  | { type: 'host:granted'; requestId: number }
  | { type: 'host:artifact-content'; requestId: number; result: ArtifactContentResult }
  | { type: 'host:artifact-list'; requestId: number; result: ArtifactListResult }
  | { type: 'host:artifact-import'; requestId: number; result: NonNullable<ArtifactImportResult> }
  | { type: 'host:media-grant'; grant: MediaGrantRecord }
  | { type: 'host:media-revoke'; sessionId: string | null } // null drops them all
  // The artifacts service's port, which the browser's pages must never reach; null when it is down.
  | { type: 'host:service-port'; port: number | null }
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
