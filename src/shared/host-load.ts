// A host's load as it reads it: the whole computer's CPU, memory, disks and battery, what uses
// them, and when it runs low. Read only while someone can see it, kept in the host's memory for an
// hour, and sent only to the owner's clients.

import type { AgentId } from './agents'
import type { MemoryState } from './idle-release'

/** How long a `host.load.watch` lasts unless the client asks again. */
export const LOAD_LEASE_MS = 30_000
/** How often a watched host reads the whole computer, and sends `host.load`. */
export const LOAD_READ_MS = 2_000
/** How often it reads what uses it, while a client shows that. */
export const LOAD_DETAIL_MS = 3_000
/** How often it reads otherwise, while a client is connected or work runs. */
export const LOAD_IDLE_MS = 60_000
/** The points of `history`: one a minute for the last hour. */
export const LOAD_HISTORY_POINTS = 60

// Disk space is counted in decimal units, as Finder and drive makers count it.
const GB = 1e9

/** A volume with a project or Kettu's data is low under the first, and very low under the second. */
export const DISK_WARN_BYTES = 10 * GB
export const DISK_CRITICAL_BYTES = 2 * GB
/** How far over its line a low volume must get back before it stops being low. */
export const DISK_MARGIN_BYTES = 2 * GB
/** On battery, the battery is low under the first percent, and very low under the second. */
export const BATTERY_WARN_PERCENT = 20
export const BATTERY_CRITICAL_PERCENT = 10
export const BATTERY_MARGIN_PERCENT = 5
/** Reads in a row under a line before it counts. */
export const STRAIN_READS = 2
/** How long a reading must stay back over its line, plus the margin, before it stops counting. */
export const STRAIN_CLEAR_MS = 5 * 60_000

export interface HostDisk {
  /** Where the volume is mounted, such as `/`, `/home` or `C:\`. */
  path: string
  /** Its name: the volume's on macOS, its mount point on Linux, its drive on Windows. */
  name: string
  /** Bytes free for the user; on macOS with the purgeable space Finder counts as available. */
  free: number
  total: number
}

export interface HostBattery {
  /** Unknown on Windows. */
  percent?: number
  charging: boolean
  onBattery: boolean
  /** Until empty on battery, until full while charging; absent when the system has no estimate. */
  minutesLeft?: number
}

export interface HostLoad {
  /** When it was read, in milliseconds since the epoch. */
  at: number
  cpu: {
    /** The whole computer's, or a container's share of its CPU limit: 0 to 100. */
    percent: number
    /** Cores, or the CPU limit of a container in cores. */
    cores: number
    /** Over 1, 5 and 15 minutes; absent on Windows. */
    loadAverage?: [number, number, number]
  }
  memory: {
    /** Bytes. */
    used: number
    total: number
    /** The system's own judgment, or by the share available where it has none. */
    state: MemoryState
  }
  /** Each volume that holds a project or Kettu's data, once. */
  disks: HostDisk[]
  /** Absent without a battery, and on Windows while it runs on mains. */
  battery?: HostBattery
  /** Seconds since the computer, or the container, started. */
  uptime: number
  /** A daemon in a container: CPU and memory are its limits. */
  container?: true
}

/** One minute of the last hour: CPU averaged over it, memory as last read, both in percent. */
export interface HostLoadPoint {
  /** The minute's start. */
  at: number
  cpu: number
  memory: number
}

/** CPU as a share of the whole computer (0 to 100), so rows add up; memory as summed RSS in bytes. */
export interface LoadUse {
  cpu: number
  memory: number
}

/**
 * What uses the computer. A process counts once: a terminal's tree, then a session's agent and
 * what it started, then an agent process several sessions share, then Kettu itself; then the
 * other programs, merged by name. Only program names leave the host, never arguments, and on
 * Linux only the programs of Kettu's own user are named. Not read on Windows.
 */
export interface HostLoadUsage {
  /** The app or daemon, its hosts and the app's pages. */
  kettu: LoadUse & { daemon?: true }
  /** A session's agent process and its descendants; a sub-session is a session of its own. */
  sessions: (LoadUse & { sessionId: string; processes: number })[]
  /** An agent's process that serves several sessions at once, with what it started. */
  agents: (LoadUse & { agentId: AgentId; sessions: number; processes: number })[]
  /** A terminal's shell and what runs in it, named as its tab. */
  terminals: (LoadUse & { terminalId: string; sessionId: string | null; name: string })[]
  /**
   * The 3 programs that use the most CPU and the 3 that use the most memory, merged by name: a
   * client shows the 3 of the order it shows and adds the others to `rest`.
   */
  others: (LoadUse & { name: string })[]
  /** The rest of the computer: what is not listed above, other users' programs included. */
  rest: LoadUse
}

/** `host.load.watch`'s answer; `usage` once a watch with detail has read it. */
export interface HostLoadWatch {
  load: HostLoad
  history: HostLoadPoint[]
  usage?: HostLoadUsage
}

/**
 * Something running low: memory the system judges critical, a volume under DISK_WARN_BYTES, or
 * the battery under BATTERY_WARN_PERCENT on battery. `value` is the share of memory left, the
 * bytes free or the battery's percent; `path` names the volume.
 */
export interface HostStrain {
  kind: 'memory' | 'disk' | 'battery'
  level: 'warn' | 'critical'
  value: number
  path?: string
}

/** What a host tells every client of its load without a watch. */
export interface HostLoadStatus {
  strains: HostStrain[]
}

/** The most pressing strain first: critical over warn, then memory, disk, battery. */
export function strainOrder(a: HostStrain, b: HostStrain): number {
  const rank = (s: HostStrain) => (s.level === 'critical' ? 0 : 3) + KINDS.indexOf(s.kind)
  return rank(a) - rank(b)
}

const KINDS: HostStrain['kind'][] = ['memory', 'disk', 'battery']
