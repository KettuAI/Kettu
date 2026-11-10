// Messages between main and the hosts: over `utilityProcess` messaging in the desktop app, or the
// IPC of `child_process.fork` when a host runs under Node.js.

import type { DeviceCall, DeviceCallAnswer } from './device-agent'
import type { RuntimeAnswer } from './artifact-capabilities'
import type { ArtifactImportResult } from './artifacts'
import type { ArtifactExportFormat, ArtifactTypeInfo, ExportedFile } from './artifact-types'
import type { AttachmentGrant } from './attachments'
import type { BrowserForward, BrowserOriginAnswer, BrowserOriginDecision } from './browser'
import type { ComputerApp } from './computer-use'
import type { MediaGrantRecord } from './media'
import type { Platform } from './platform'
import type { PortError } from './port-rpc'
import type { DeviceActivity } from './remote/activity'
import type { NewDevice, PairedDevice, PortDevice } from './remote/device'
import type { DiscoveredHosts, DiscoveryRequestEvent } from './remote/discovery'
import type { HostAdminEvent, HostAdminMethod } from './remote/host-admin'
import type { HostPairingState, HostStatus } from './remote/hosts'
import type { PairingState } from './remote/pairing'
import type { DirectAddress } from './remote/protocol'
import type { ReportBuildResult, ReportRequest } from './report'
import type { RelayStatus } from './remote/relay-host'
import type { DirectSettings, HostSettings, SettingsFile, TerminalSettings } from './settings'
import type { AgentId } from './thread'

export type { ReportBuildResult }

export interface BusySession {
  sessionId: string
  agentId: AgentId
  title: string | null
  turnStartedAt: number | null // when its running turn started, for how long it has run
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
      // The desktop app's computer use: the driver it ships and Kettu's own process and app ids.
      computer?: { driverPath: string; selfPid: number; selfIds: string[] }
    }
  | { type: 'host:connect'; windowId: number } // the port travels in the transfer list
  // A paired device's session, which may do less than a window. In the desktop app the port
  // travels in the transfer list; under Node.js this is the first message on the socket's port.
  | { type: 'host:connect'; device: PortDevice }
  | { type: 'host:settings'; settings: HostSettings }
  // The values of the Marketplace servers' inputs, by server id and input name, all of them each
  // time: right after host:init at every start, and whenever they change.
  // The key store, whole: input values by server id, then input name; and each OAuth server's
  // sign-in, an opaque JSON text only the agent host reads, by server id.
  | {
      type: 'host:market-keys'
      values: Record<string, Record<string, string>>
      oauth?: Record<string, string>
    }
  | { type: 'host:busy-request'; requestId: number }
  // A problem report's bundle, answered by host:report. The parent adds its own part; the host
  // reads the logs, its agents and sessions, and writes the zip under its data folder.
  | {
      type: 'host:report-request'
      requestId: number
      request: ReportRequest
      parent: Record<string, unknown>
      settings: SettingsFile | null
      crashDir: string | null
      screenshot: string | null // PNG in base64, as a forked host's messages are JSON
    }
  | { type: 'host:grant'; requestId: number; grants: AttachmentGrant[] } // answered by host:granted
  // `artifact.content`: the files of a version, the latest when `version` is null.
  | { type: 'host:artifact-content-request'; requestId: number; id: string; version: number | null }
  // `artifact.list`: the id of every artifact the host has, Recently deleted included.
  | { type: 'host:artifact-list-request'; requestId: number }
  // `artifact.import`: a file or folder the user chose in main's dialog, made an artifact in
  // `project`, or in a new scratch folder when `project` is null.
  | {
      type: 'host:artifact-import-request'
      requestId: number
      path: string
      project: string | null
    }
  // A page's message to the runtime, from the artifact origin main serves it on: answered by
  // host:artifact-runtime-answer under the same id, once, or for a stream with each event and the end.
  | { type: 'host:artifact-runtime'; requestId: number; artifactId: string; message: unknown }
  // The page closed the request, which ends its stream.
  | { type: 'host:artifact-runtime-cancel'; requestId: number }
  // `artifact.export`: a typed version converted on the host, for main to save.
  | {
      type: 'host:artifact-export-request'
      requestId: number
      id: string
      version: number
      format: ArtifactExportFormat
    }
  | { type: 'host:power'; state: 'suspend' | 'resume' }
  /** `verbose`: detailed records, which the debug level alone does not write. */
  | { type: 'host:log-level'; level: 'debug' | 'info'; verbose: boolean }
  // Allow once, from a request's notification: answered as one of the host's own windows would.
  | { type: 'host:permission-answer'; sessionId: string; requestId: string; optionId: string }
  // The answer to a host:browser-call, its result or the error that refused it.
  | { type: 'browser-result'; callId: number; result?: unknown; error?: unknown }
  // The answer to a host:device-call, from the device host.
  | { type: 'device-result'; callId: number; answer: DeviceCallAnswer }
  // A browser call now waits for the user to answer a new origin, so its limit grows to that wait.
  | { type: 'host:browser-waiting'; callId: number; waiting: boolean }
  // A page waits for a new origin: the session's thread shows it, waiting for the user.
  | { type: 'host:browser-origin-ask'; requestId: number; sessionId: string; origin: string }
  // The wait ended, from the pane or the card, so the session's card takes the answer.
  | { type: 'host:browser-origin-answer'; requestId: number; decision: BrowserOriginAnswer }
  | { type: 'host:shutdown' }

/** A file of an artifact's version: its path in the artifact, and where its bytes lie on disk. */
export interface ArtifactContentFile {
  path: string
  file: string // in artifacts/content/
  size: number
}

/**
 * The host's answer to `host:artifact-content-request`: the version's files, and `key`, which
 * names what they are together, for its thumbnail.
 */
export type ArtifactContentResult =
  | {
      kind: 'found'
      version: number
      title: string
      key: string
      /** The latest version declares what reads beyond the page, so its pages get no CDN. */
      strict: boolean
      files: ArtifactContentFile[]
      /** Made from a type: its viewer is served in place of the entry page. */
      type?: ArtifactTypeInfo | null
    }
  | { kind: 'not_found' }
  | { kind: 'failed' }

/** The host's answer to `host:artifact-export-request`. */
export type ArtifactExportResult =
  | { kind: 'exported'; title: string; files: ExportedFile[] }
  | { kind: 'not_found' }
  | { kind: 'failed'; message: string }

/** What main needs to know of an artifact to publish it: its latest version and when it was made. */
export interface ArtifactBrief {
  id: string
  version: number
  createdAt: number
  updatedAt: number
  /** In Recently deleted. */
  deleted: boolean
}

/** The host's answer to `host:artifact-list-request`. */
export type ArtifactListResult = { kind: 'listed'; artifacts: ArtifactBrief[] } | { kind: 'failed' }

/** An agent process the host runs; its start time tells it apart from a later one with its pid. */
export interface AgentProcess {
  agentId: AgentId
  pid: number
  startedAt: number
}

/** A request's one-time answer a notification may offer, by the agent's own name for it. */
export interface AttentionAnswer {
  optionId: string
  name: string
}

/**
 * The request behind a permission's attention: the id `host:waiting` lists it under while it
 * waits, and the one-time answers when the request fits in a notification.
 */
export interface AttentionRequest {
  id: string
  allow?: AttentionAnswer
  deny?: AttentionAnswer
}

/** Who had the session in front when it happened: any window or device, and which devices. */
export interface AttentionFront {
  any: boolean
  devices: string[]
}

export type HostToMain =
  // Keep (or, with null, clear) a server's OAuth sign-in after the host connected, renewed or
  // disconnected it; main stores the text as it stores keys and pushes host:market-keys again.
  | { type: 'host:market-oauth'; serverId: string; state: string | null }
  | { type: 'host:ready' }
  | { type: 'host:agent-processes'; processes: AgentProcess[] }
  | { type: 'host:projects'; paths: string[] }
  /** An artifact was made, changed, deleted or restored. */
  | { type: 'host:artifacts-changed' }
  /** Sessions archived or deleted, whose terminals end. */
  | { type: 'host:sessions-ended'; sessionIds: string[] }
  | { type: 'host:auth-commands'; commands: string[] } // terminal sign-in commands it built
  | {
      type: 'host:attention'
      sessionId: string
      kind: 'permission' | 'turn-ended' | 'error' | 'routine-ended'
      title: string
      body: string
      // A request the notification may allow once itself, without opening the session.
      allowOnce?: { requestId: string; optionId: string }
      request?: AttentionRequest
      front?: AttentionFront
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
  // What waits for the user, by session: the ids of the requests, new sites, apps and setups.
  | { type: 'host:waiting'; sessions: Record<string, string[]> }
  // A window or device showed the session, or it was marked read: its turn was seen.
  | { type: 'host:seen'; sessionId: string }
  | ({ type: 'host:busy-changed' } & BusyCounts) // for the tray's state line
  // Whether any routine run is starting or running, for keeping the computer from idle sleep.
  | { type: 'host:routines-working'; working: boolean }
  | { type: 'host:busy'; requestId: number; sessions: BusySession[] }
  | { type: 'host:report'; requestId: number; result: ReportBuildResult }
  | { type: 'host:granted'; requestId: number }
  | { type: 'host:artifact-content'; requestId: number; result: ArtifactContentResult }
  | { type: 'host:artifact-list'; requestId: number; result: ArtifactListResult }
  | { type: 'host:artifact-import'; requestId: number; result: NonNullable<ArtifactImportResult> }
  | { type: 'host:artifact-runtime-answer'; requestId: number; answer: RuntimeAnswer }
  | { type: 'host:artifact-export'; requestId: number; result: ArtifactExportResult }
  | { type: 'host:media-grant'; grant: MediaGrantRecord }
  | { type: 'host:media-revoke'; sessionId: string | null } // null drops them all
  // A window's or device's answer to the new origin main's page asked for, from the session's card.
  | {
      type: 'host:browser-origin-decide'
      sessionId: string
      requestId: number
      decision: BrowserOriginDecision
    }
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
  // An agent's device tool call for the device host; answered by device-result.
  | { type: 'host:device-call'; callId: number; call: DeviceCall }
  // The artifacts service's port, which the browser's pages must never reach; null when it is down.
  | { type: 'host:service-port'; port: number | null }
  // A session's card allowed an app always: main keeps it in the settings, which come back.
  | { type: 'host:computer-app-allow'; app: ComputerApp }
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
  | { type: 'terminal-host:sessions-ended'; sessionIds: string[] }
  | { type: 'terminal-host:auth-commands'; commands: string[] }
  | { type: 'terminal-host:busy-request'; requestId: number }
  | { type: 'terminal-host:shutdown' }

export type TerminalHostToMain =
  | { type: 'terminal-host:ready' }
  | { type: 'terminal-host:busy'; requestId: number; terminals: BusyTerminal[] }
  | { type: 'terminal-host:stopped' }

export type MainToDeviceHost =
  | {
      type: 'device-host:init'
      platform: Platform
      appVersion: string
      nodeRuntime: NodeRuntime
      /** Kettu's data folder, where agent-device keeps its state. */
      dataDir: string
      /** The packaged app's resources, which hold the helpers; null in development. */
      resourcesPath: string | null
      allowDevices: boolean
      // Under Node.js, the local socket the host takes its ports on; the desktop app hands them over.
      socketPath?: string
    }
  // The port travels in the transfer list; `device` names the paired device it serves, if any.
  | { type: 'device-host:connect'; windowId: number; device?: PortDevice }
  | { type: 'device-host:allow-devices'; allowed: boolean }
  | { type: 'device-host:sessions-ended'; sessionIds: string[] }
  /** An agent's device tool call, which the agent host sent its parent. */
  | { type: 'device-host:call'; callId: number; call: DeviceCall }
  | { type: 'device-host:shutdown' }

export type DeviceHostToMain =
  | { type: 'device-host:ready' }
  | { type: 'device-host:answer'; callId: number; answer: DeviceCallAnswer }
  | { type: 'device-host:stopped' }

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
      /**
       * Under the daemon: the port to take channels from SSH on, on 127.0.0.1 alone, as the last
       * run listened; null for any free one. Absent in the desktop app, which takes none.
       */
      sshPort?: number | null
      /** The Kettu relay, for serving devices through it and reaching other hosts. */
      relay?: RelayInit
      /** The push gateway's origin, which the devices' notifications go through. */
      push?: string
      /** What waits for the user and whether they are at the computer, as last told. */
      waiting?: Record<string, string[]>
      present?: boolean
      /**
       * Devices of the same Kettu account find this host on the relay and ask to be added;
       * `remote-host:discoverable` says when it changes. Absent, as under the daemon, they do not.
       */
      discoverable?: boolean
    }
  // The answer to remote-host:open-port: the agent host's port travels in the transfer list, and
  // none comes while the agent host is not running. It answers remote-host:open-terminal-port the
  // same way with the terminal host's, none while devices may not use it or it cannot run.
  | { type: 'remote-host:port'; requestId: number }
  // Under Node.js, the answer to remote-host:open-terminal-port: the terminal host's socket, which
  // the remote host connects to itself; null while devices may not use it or it cannot run.
  | { type: 'remote-host:terminal-socket'; requestId: number; socketPath: string | null }
  // Under Node.js, the answer to remote-host:open-device-port: the device host's socket.
  | { type: 'remote-host:device-socket'; requestId: number; socketPath: string | null }
  // The owner allowed devices the terminal or stopped allowing it.
  | { type: 'remote-host:terminal'; allowed: boolean }
  | { type: 'remote-host:add-device'; device: NewDevice }
  // Forgets the device and closes its sessions at once.
  | { type: 'remote-host:remove-device'; id: string }
  // The direct connections' settings changed.
  | { type: 'remote-host:direct'; direct: DirectSettings }
  // Remote access turned on while the host runs for other hosts, with what `remote-host:init`
  // would have carried.
  | {
      type: 'remote-host:serve'
      privateKey: string
      plainTextKey: boolean
      direct: DirectSettings
      /** The Ed25519 seed to sign in to the relay with, in base64. Never logged. */
      relayKey?: string
    }
  // Use the Kettu relay turned on or off.
  | { type: 'remote-host:relay'; enabled: boolean }
  // Whether devices of the account find this host on the relay; off ends the open request.
  | { type: 'remote-host:discoverable'; enabled: boolean }
  // The owner's answer to a discovery request, with the name to add the device under.
  | { type: 'remote-host:discovery-answer'; requestId: number; add: boolean; name: string }
  // Lists the account's hosts this computer may pair with; answered by remote-host:discovered.
  | { type: 'remote-host:discover'; requestId: number }
  // Pairs with a host remote-host:discover listed, by its relay id, as remote-host:pair-host does.
  | { type: 'remote-host:pair-discovered'; pairId: number; relayId: string; model: string }
  // This computer's user saw the same code on both screens, or not, which ends the pairing.
  | { type: 'remote-host:pair-match'; pairId: number; match: boolean }
  // A fresh access token of the account this computer is signed in to, or null once signed out,
  // which closes every relay socket. Never logged.
  | { type: 'remote-host:token'; token: string | null }
  // Retry on the relay: tries every relay now, a conflict included.
  | { type: 'remote-host:relay-retry' }
  // Remote access turned off: devices hear `remote_off` and nothing listens, while the
  // connections to other hosts go on. Answered by remote-host:stop-serving once the device files
  // are written for the last time, which main then reads and changes itself.
  | { type: 'remote-host:stop-serving'; requestId: number }
  // The answer to remote-host:open-host-port: the port travels in the transfer list.
  | { type: 'remote-host:host-port'; requestId: number }
  // Pairs with the host of a pairing link, suggesting this computer's model; its progress comes
  // back as remote-host:host-pairing under the same id.
  | { type: 'remote-host:pair-host'; pairId: number; link: string; model: string }
  // Adds the machine at an SSH address, the same way, and is closed as a pairing is.
  | { type: 'remote-host:add-ssh-host'; pairId: number; target: string; model: string }
  // Add host closed: the pairing connection ends, unless it was added.
  | { type: 'remote-host:pair-host-close'; pairId: number }
  // Renames this computer on a host it is connected to; the host's `renamed` answers.
  | { type: 'remote-host:rename-on-host'; id: string; name: string }
  // The addresses a known host is tried at, as the owner edited them here.
  | { type: 'remote-host:host-addresses'; id: string; addresses: DirectAddress[] }
  // Forgets a host here; nothing changes on it.
  | { type: 'remote-host:remove-host'; id: string }
  // A port on this computer's loopback that reaches a dev server on a host, for the page of the
  // host's session; answered by remote-host:forwarding under the same id.
  | {
      type: 'remote-host:forward'
      requestId: number
      hostId: string
      sessionId: string
      forward: BrowserForward
    }
  // The session's page is gone: its forwards on that host close.
  | { type: 'remote-host:forward-close'; hostId: string; sessionId: string }
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
  // What the agent host says needs the user, what waits and what was seen, for the devices'
  // notifications.
  | { type: 'remote-host:attention'; attention: Extract<HostToMain, { type: 'host:attention' }> }
  | { type: 'remote-host:waiting'; sessions: Record<string, string[]> }
  | { type: 'remote-host:seen'; sessionId: string }
  // The desktop app's user is at the computer: its screen unlocked and input in the last two
  // minutes. The daemon sends none, since it cannot tell.
  | { type: 'remote-host:presence'; present: boolean }
  // Tells every device why, then stops.
  | { type: 'remote-host:shutdown'; reason: RemoteHostStopReason }

/** What the remote host starts the relay with. */
export interface RelayInit {
  /** The main relay's origin, which lists the regions. */
  url: string
  /** Use the Kettu relay, as the setting is. */
  enabled: boolean
  /**
   * The 32-byte Ed25519 seed the host signs in with, in base64; absent while remote access is
   * off. Never logged.
   */
  key?: string
  /** The account's access token; null while this computer is not signed in. Never logged. */
  token: string | null
}

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
  /**
   * The port channels from SSH reach, on 127.0.0.1 alone; null when none could listen. Absent
   * in the desktop app.
   */
  sshPort?: number | null
  /** Each relay the host signs in to and how it is doing; none while it signs in to none. */
  relays: RelayStatus[]
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
  // A port to the device host for a device's mobile devices; answered by remote-host:port in the
  // desktop app and by remote-host:device-socket under Node.js.
  | { type: 'remote-host:open-device-port'; requestId: number; device: PortDevice }
  | { type: 'remote-host:pairing'; codeId: number; pairing: PairingState }
  // A device of the account asks to be added, or that request ended.
  | { type: 'remote-host:discovery'; event: DiscoveryRequestEvent }
  | { type: 'remote-host:discovered'; requestId: number; result: DiscoveredHosts }
  // The known hosts and their connections, whenever they change.
  | { type: 'remote-host:hosts'; hosts: HostStatus[] }
  | { type: 'remote-host:host-pairing'; pairId: number; pairing: HostPairingState }
  // A port for a host's device session, which carries the host protocol; answered by
  // remote-host:host-port.
  | { type: 'remote-host:open-host-port'; requestId: number; hostId: string }
  // Newest first.
  | { type: 'remote-host:activity'; requestId: number; events: DeviceActivity[] }
  // The port remote-host:forward listens on, null when the host's session or the port is not there.
  | { type: 'remote-host:forwarding'; requestId: number; port: number | null }
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
