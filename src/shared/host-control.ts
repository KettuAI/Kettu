// Messages between main and the hosts: over `utilityProcess` messaging in the desktop app, or the
// IPC of `child_process.fork` when a host runs under Node.js.

import type { ArtifactImportResult } from './artifacts'
import type { AttachmentGrant } from './attachments'
import type { BrowserOriginAnswer } from './browser'
import type { MediaGrantRecord } from './media'
import type { Platform } from './platform'
import type { PortError } from './port-rpc'
import type { DeviceActivity } from './remote/activity'
import type { NewDevice, PairedDevice, PortDevice } from './remote/device'
import type { HostAdminEvent, HostAdminMethod } from './remote/host-admin'
import type { HostPairingState, HostStatus } from './remote/hosts'
import type { PairingState } from './remote/pairing'
import type { DirectAddress } from './remote/protocol'
import type { DirectSettings, HostSettings, TerminalSettings } from './settings'
import type { AgentId } from './thread'

export interface BusySession {
  sessionId: string
  agentId: AgentId
  title: string | null
}

/** Sessions whose turn is running, and how many of them wait for the user to approve something. */
export interface BusyCounts {
  running: number
  waiting: number
}

/**
 * The program that runs a script as Node.js, for the shell probe and the agents that are scripts:
 * Electron's binary with ELECTRON_RUN_AS_NODE in the desktop app, Node.js itself under Node.js.
 */
export interface NodeRuntime {
  command: string
  /** Variables the program needs to run as Node.js, over the environment it is given. */
  env: Record<string, string>
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
      nodeRuntime: NodeRuntime
      fakeAgentPath: string | null // tools/fake-agent/main.ts in development, or from KETTU_FAKE_AGENT
      threadWorkerPath: string // the thread worker's bundle, which main builds beside the host's
      usageWorkerPath: string // the usage worker's bundle, built the same way
      // The session router's bundle, which a per-session agent's process runs under the user's Node.js.
      sessionRouterPath: string
      settings: HostSettings
      // Under Node.js, the local socket the host takes its ports on; the desktop app hands them over.
      socketPath?: string
    }
  | { type: 'host:connect'; windowId: number } // the port travels in the transfer list
  // A paired device's session, which may do less than a window. In the desktop app the port
  // travels in the transfer list; under Node.js this is the first message on the socket's port.
  | { type: 'host:connect'; device: PortDevice }
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
  // The answer to a host:browser-call, its result or the error that refused it.
  | { type: 'browser-result'; callId: number; result?: unknown; error?: unknown }
  // A browser call now waits for the user to answer a new origin, so its limit grows to that wait.
  | { type: 'host:browser-waiting'; callId: number; waiting: boolean }
  // A page waits for a new origin: the session's thread shows it, waiting for the user.
  | { type: 'host:browser-origin-ask'; requestId: number; sessionId: string; origin: string }
  // The wait ended, from the pane or the card, so the session's card takes the answer.
  | { type: 'host:browser-origin-answer'; requestId: number; decision: BrowserOriginAnswer }
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
  | ({ type: 'host:busy-changed' } & BusyCounts) // for the tray's state line
  // Whether any routine run is starting or running, for keeping the computer from idle sleep.
  | { type: 'host:routines-working'; working: boolean }
  | { type: 'host:busy'; requestId: number; sessions: BusySession[] }
  | { type: 'host:granted'; requestId: number }
  | { type: 'host:artifact-content'; requestId: number; result: ArtifactContentResult }
  | { type: 'host:artifact-list'; requestId: number; result: ArtifactListResult }
  | { type: 'host:artifact-import'; requestId: number; result: NonNullable<ArtifactImportResult> }
  | { type: 'host:media-grant'; grant: MediaGrantRecord }
  | { type: 'host:media-revoke'; sessionId: string | null } // null drops them all
  // A browser tool call for main to run on the session's page; answered by browser-result.
  | {
      type: 'host:browser-call'
      callId: number
      sessionId: string
      tool: string
      args: Record<string, unknown>
      /** The calling session's project, which its always-allowed sites are stored under. */
      projectPath: string
    }
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
      // Under Node.js, the local socket the host takes its ports on; the desktop app hands them over.
      socketPath?: string
    }
  // The port travels in the transfer list; `device` names the paired device it serves, if any.
  | { type: 'terminal-host:connect'; windowId: number; device?: PortDevice }
  | { type: 'terminal-host:settings'; settings: TerminalSettings }
  | { type: 'terminal-host:projects'; paths: string[] }
  | { type: 'terminal-host:auth-commands'; commands: string[] }
  | { type: 'terminal-host:busy-request'; requestId: number }
  | { type: 'terminal-host:shutdown' }

export type TerminalHostToMain =
  | { type: 'terminal-host:ready' }
  | { type: 'terminal-host:busy'; requestId: number; terminals: BusyTerminal[] }
  | { type: 'terminal-host:stopped' }

export type RemoteHostStopReason = 'remote_off' | 'stopping'

/** How the host's parent answers an owner's call: the result, or the error that refused it. */
export type AdminAnswer = { result: unknown } | { error: PortError }

export type MainToRemoteHost =
  | {
      type: 'remote-host:init'
      userDataPath: string
      appVersion: string
      platform: Platform
      /** The name devices show for this computer, and the one it suggests when it pairs. */
      hostName: string
      /**
       * The 32 bytes of the host's X25519 private key, in base64. Never logged. Absent while remote
       * access is off: the host then listens nowhere and takes no device.
       */
      privateKey?: string
      /** The key is kept in a file only the user can read, without the system's encryption. */
      plainTextKey: boolean
      /** Direct connections on the same network or a VPN; off when absent. */
      direct?: DirectSettings
      /**
       * The folder of the web client's built files the direct port serves; absent in a build
       * without one.
       */
      webRoot?: string
      /** Whether devices may use the terminal; `remote-host:terminal` says when it changes. */
      terminal: boolean
      /**
       * The desktop app as a device of other hosts: the 32 bytes of its own X25519 private key, in
       * base64 and never logged, and its system as its hello names it. Absent under the daemon.
       */
      device?: { privateKey: string; platform: string }
      // Under Node.js: the agent host's socket, which each device's session connects to, and a
      // local socket devices may connect on, each connection a stream transport.
      agentHostSocket?: string
      socketPath?: string
    }
  // The answer to remote-host:open-port: the agent host's port travels in the transfer list, and
  // none comes while the agent host is not running. It answers remote-host:open-terminal-port the
  // same way with the terminal host's, none while devices may not use it or it cannot run.
  | { type: 'remote-host:port'; requestId: number }
  // Under Node.js, the answer to remote-host:open-terminal-port: the terminal host's socket, which
  // the remote host connects to itself; null while devices may not use it or it cannot run.
  | { type: 'remote-host:terminal-socket'; requestId: number; socketPath: string | null }
  // The owner allowed devices the terminal or stopped allowing it.
  | { type: 'remote-host:terminal'; allowed: boolean }
  | { type: 'remote-host:add-device'; device: NewDevice }
  // Forgets the device and closes its sessions at once.
  | { type: 'remote-host:remove-device'; id: string }
  // The direct connections' settings changed.
  | { type: 'remote-host:direct'; direct: DirectSettings }
  // Remote access turned on while the host runs for other hosts, with what `remote-host:init`
  // would have carried.
  | { type: 'remote-host:serve'; privateKey: string; plainTextKey: boolean; direct: DirectSettings }
  // Remote access turned off: devices hear `remote_off` and nothing listens, while the
  // connections to other hosts go on. Answered by remote-host:stop-serving once the device files
  // are written for the last time, which main then reads and changes itself.
  | { type: 'remote-host:stop-serving'; requestId: number }
  // The answer to remote-host:open-host-port: the port travels in the transfer list.
  | { type: 'remote-host:host-port'; requestId: number }
  // Pairs with the host of a pairing link, suggesting this computer's model; its progress comes
  // back as remote-host:host-pairing under the same id.
  | { type: 'remote-host:pair-host'; pairId: number; link: string; model: string }
  // Add host closed: the pairing connection ends, unless it was added.
  | { type: 'remote-host:pair-host-close'; pairId: number }
  // Renames this computer on a host it is connected to; the host's `renamed` answers.
  | { type: 'remote-host:rename-on-host'; id: string; name: string }
  // The addresses a known host is tried at, as the owner edited them here.
  | { type: 'remote-host:host-addresses'; id: string; addresses: DirectAddress[] }
  // Forgets a host here; nothing changes on it.
  | { type: 'remote-host:remove-host'; id: string }
  // The computer woke from sleep, maybe on another network: the direct addresses are read again
  // and the hosts not connected are tried at once.
  | { type: 'remote-host:resume' }
  | { type: 'remote-host:rename-device'; id: string; name: string }
  // Opens a pairing code for the asker `codeId` names, voiding any code still open; its progress
  // comes back as remote-host:pairing under the same id.
  | { type: 'remote-host:pair'; codeId: number }
  // The asker closed Add device, which voids its code.
  | { type: 'remote-host:pair-close'; codeId: number }
  // The asker's answer to a device whose secret checked out, with the name to add it under.
  | { type: 'remote-host:pair-answer'; codeId: number; add: boolean; name: string }
  // A device's activity; answered by remote-host:activity.
  | { type: 'remote-host:activity'; requestId: number; id: string }
  | { type: 'remote-host:host-name'; name: string }
  // Removes every device and voids the code, before main makes a new identity; answered by
  // remote-host:reset.
  | { type: 'remote-host:reset'; requestId: number }
  // The answer to remote-host:admin-call under the same id.
  | ({ type: 'remote-host:admin-result'; requestId: number } & AdminAnswer)
  // Something the owner's devices hear of the host: every one, or only `deviceId`'s sessions.
  | { type: 'remote-host:admin-event'; event: HostAdminEvent; deviceId: string | null }
  // Tells every device why, then stops.
  | { type: 'remote-host:shutdown'; reason: RemoteHostStopReason }

/** What the remote host reports to main, for Settings. */
export interface RemoteHostStatus {
  /** The host's X25519 public key, in base64, for pairing codes. */
  publicKey: string
  plainTextKey: boolean
  devices: PairedDevice[]
  /** The ids of the devices with a session open now. */
  online: string[]
  /**
   * Connections refused since the remote host started: at their first message, or by the limits
   * on direct connections' handshakes.
   */
  refused: number
  direct: DirectStatus
}

/** Direct connections, as the remote host runs them. */
export type DirectStatus =
  | { state: 'off' }
  /** `port` is open on every interface; `addresses` are what devices are told, the owner's first. */
  | { state: 'listening'; port: number; addresses: DirectAddress[] }
  /** The port could not be opened; it is tried again only when the settings change. */
  | { state: 'failed'; port: number; reason: 'port_in_use' | 'not_permitted' | 'other' }

export type RemoteHostToMain =
  | { type: 'remote-host:ready' }
  | { type: 'remote-host:status'; status: RemoteHostStatus }
  // A port to the agent host for a device's session; answered by remote-host:port.
  | { type: 'remote-host:open-port'; requestId: number; device: PortDevice }
  // A port to the terminal host for a device's terminals; answered by remote-host:port in the
  // desktop app and by remote-host:terminal-socket under Node.js.
  | { type: 'remote-host:open-terminal-port'; requestId: number; device: PortDevice }
  | { type: 'remote-host:log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'remote-host:pairing'; codeId: number; pairing: PairingState }
  // The known hosts and their connections, whenever they change.
  | { type: 'remote-host:hosts'; hosts: HostStatus[] }
  | { type: 'remote-host:host-pairing'; pairId: number; pairing: HostPairingState }
  // A port for a host's device session, which carries the host protocol; answered by
  // remote-host:host-port.
  | { type: 'remote-host:open-host-port'; requestId: number; hostId: string }
  // Newest first.
  | { type: 'remote-host:activity'; requestId: number; events: DeviceActivity[] }
  // A call an owner's device makes of the host beyond its sessions; answered by
  // remote-host:admin-result.
  | {
      type: 'remote-host:admin-call'
      requestId: number
      deviceId: string
      method: HostAdminMethod
      params: unknown
    }
  | { type: 'remote-host:reset'; requestId: number }
  | { type: 'remote-host:stop-serving'; requestId: number }
  | { type: 'remote-host:stopped' }
