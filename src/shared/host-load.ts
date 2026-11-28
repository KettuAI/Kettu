// A host's load: totals of the whole computer, CPU, memory, disk, network, power and battery.
// Read only while a client watches, sent only to the owner's clients, and never kept.

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

/** Direction of battery power flow when a battery power reading is available. */
export type HostBatteryPowerState = 'charging' | 'discharging' | 'idle'

/**
 * Reliable power consumption readings the host can obtain without elevated privileges, in watts.
 * Absent on `HostLoad` when no field has a reliable reading.
 */
export interface HostPowerLoad {
  /** Whole-system power draw in watts; null when the OS/hardware does not reliably report it. */
  systemWatts: number | null
  /** CPU package power draw in watts (e.g. Linux RAPL); null when unavailable. */
  cpuWatts: number | null
  /** Battery charge or discharge power magnitude in watts; null when unavailable. */
  batteryWatts: number | null
  /** Direction of `batteryWatts` when a battery power reading is present. */
  batteryState?: HostBatteryPowerState
}

/** The headline power reading for compact load headers: whole system first, else CPU only. */
export interface PrimaryPowerReading {
  kind: 'system' | 'cpu'
  watts: number
}

const BATTERY_POWER_STATES = new Set<HostBatteryPowerState>(['charging', 'discharging', 'idle'])

function validWatts(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value === 0 ? 0 : value
}

/**
 * Validates and normalizes an untrusted `HostPowerLoad` wire payload.
 * Returns null when invalid or when no reliable wattage reading is present.
 */
export function parseHostPowerLoad(value: unknown): HostPowerLoad | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const systemWatts =
    record.systemWatts === undefined || record.systemWatts === null
      ? null
      : validWatts(record.systemWatts)
  const cpuWatts =
    record.cpuWatts === undefined || record.cpuWatts === null ? null : validWatts(record.cpuWatts)
  const batteryWatts =
    record.batteryWatts === undefined || record.batteryWatts === null
      ? null
      : validWatts(record.batteryWatts)
  if (
    (record.systemWatts !== undefined && record.systemWatts !== null && systemWatts === null) ||
    (record.cpuWatts !== undefined && record.cpuWatts !== null && cpuWatts === null) ||
    (record.batteryWatts !== undefined && record.batteryWatts !== null && batteryWatts === null)
  ) {
    return null
  }
  if (systemWatts === null && cpuWatts === null && batteryWatts === null) return null
  const rawState = record.batteryState
  let batteryState: HostBatteryPowerState | undefined
  if (rawState !== undefined && rawState !== null) {
    if (
      typeof rawState !== 'string' ||
      !BATTERY_POWER_STATES.has(rawState as HostBatteryPowerState)
    ) {
      return null
    }
    if (batteryWatts !== null) batteryState = rawState as HostBatteryPowerState
  }
  return {
    systemWatts,
    cpuWatts,
    batteryWatts,
    ...(batteryState ? { batteryState } : {}),
  }
}

/**
 * Picks the single overview power reading for a load header: whole-system power when available,
 * otherwise CPU package power explicitly tagged as `cpu`. Never promotes battery power alone.
 */
export function primaryPowerReading(
  power: HostPowerLoad | null | undefined,
): PrimaryPowerReading | null {
  if (!power) return null
  if (typeof power.systemWatts === 'number' && Number.isFinite(power.systemWatts)) {
    return { kind: 'system', watts: power.systemWatts }
  }
  if (typeof power.cpuWatts === 'number' && Number.isFinite(power.cpuWatts)) {
    return { kind: 'cpu', watts: power.cpuWatts }
  }
  return null
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
  /**
   * Unprivileged power consumption readings in watts (whole system, CPU package, and/or battery).
   * Absent when the host has no reliable sensor reading.
   */
  power?: HostPowerLoad
  /** A daemon in a container: CPU and memory are its limits, disk activity and network its own. */
  container?: true
}

/** `host.load.watch`'s answer: the load now. */
export interface HostLoadWatch {
  load: HostLoad
}
