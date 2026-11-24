// A host's load: totals of the whole computer, CPU, memory, disk, network and battery. Read only
// while a client watches, sent only to the owner's clients, and never kept.

import type { MemoryState } from './idle-release'

/** How long a `host.load.watch` lasts unless the client asks again. */
export const LOAD_LEASE_MS = 30_000
/** How often a watched host reads its load, and sends `host.load`. */
export const LOAD_READ_MS = 2_000

// Disk space is counted in decimal units, as Finder and drive makers count it.
const GB = 1e9

/** The disk's bar turns yellow under the first, and red under the second. */
export const DISK_WARN_BYTES = 10 * GB
export const DISK_CRITICAL_BYTES = 2 * GB
/** On battery, the battery turns yellow at the first percent or less, and red at the second. */
export const BATTERY_WARN_PERCENT = 20
export const BATTERY_CRITICAL_PERCENT = 10

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
  }
  memory: {
    /** Bytes. */
    used: number
    total: number
    /** The system's own judgment, or by the share available where it has none. */
    state: MemoryState
  }
  /**
   * Of the volumes that hold a project or Kettu's data, the one with the least free space; on
   * macOS free counts the purgeable space Finder counts as available. Absent when none was read.
   */
  disk?: { name: string; free: number; total: number }
  /** The whole computer's disk reads and writes, in bytes per second; absent where not read. */
  io?: { readPerSecond: number; writePerSecond: number }
  /**
   * Received and sent over the physical interfaces, so a VPN or a proxy's tunnel is not counted
   * twice, in bytes per second; a container's over its own interfaces but loopback.
   */
  network?: { receivePerSecond: number; sendPerSecond: number }
  /** Absent without a battery, and on Windows while it runs on mains. */
  battery?: HostBattery
  /** A daemon in a container: CPU and memory are its limits, disk activity and network its own. */
  container?: true
}

/** `host.load.watch`'s answer: the load now. */
export interface HostLoadWatch {
  load: HostLoad
}
