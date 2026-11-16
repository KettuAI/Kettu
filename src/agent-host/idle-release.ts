// When idle Claude Code sessions let their agent go: the host's setting, the system's memory read
// once a minute, and the Claude Code versions whose resumes lost the prompt cache.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import type {
  IdleReleaseRule,
  IdleReleaseState,
  IdleSessionsSettings,
  MemoryState,
} from '@shared/idle-release'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'

const MINUTE = 60_000
export const MEMORY_READ_MS = MINUTE
/** About what one idle Claude Code process holds: 173 to 294 MB were measured. */
const PROCESS_BYTES = 300 * 1024 * 1024
/** Idle processes together stay under this share of the memory while it is not critical. */
const MEMORY_SHARE = 0.1
/** At least this share available is plenty, and under the second one critical. */
const PLENTY_PERCENT = 20
const CRITICAL_PERCENT = 10
// macOS's `kern.memorystatus_vm_pressure_level`.
const PRESSURE_WARNING = 2
const PRESSURE_CRITICAL = 4
/** Under this share of the context before, a resume's first request missed the cache. */
const MISS_SHARE = 0.5
/** Misses in a row on one version that put it in fallback. */
const MISSES_FOR_FALLBACK = 2

export interface MemoryReading {
  state: MemoryState
  /** The share of memory available, in percent; null when unknown. */
  available: number | null
  /** macOS's pressure level: 1 normal, 2 warning, 4 critical. */
  pressure?: number
}

const UNKNOWN: MemoryReading = { state: 'unknown', available: null }

function byShare(available: number): MemoryState {
  if (available >= PLENTY_PERCENT) return 'plenty'
  return available >= CRITICAL_PERCENT ? 'tight' : 'critical'
}

function sysctl(names: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/sysctl', ['-n', ...names], { timeout: 5_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
  })
}

/**
 * The system's own judgment of its memory. macOS's free page count stays near zero while most of
 * it is cache, so there the pressure level and the share available decide.
 */
export async function readMemory(platform: Platform): Promise<MemoryReading> {
  if (platform === 'darwin') {
    const [pressure, available] = (
      await sysctl(['kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'])
    )
      .trim()
      .split(/\s+/)
      .map(Number)
    if (!Number.isFinite(pressure) || !Number.isFinite(available)) return UNKNOWN
    const state =
      pressure! >= PRESSURE_CRITICAL
        ? 'critical'
        : pressure! >= PRESSURE_WARNING || available! < PLENTY_PERCENT
          ? 'tight'
          : 'plenty'
    return { state, available: available!, pressure: pressure! }
  }
  if (platform === 'linux') {
    const info = await readFile('/proc/meminfo', 'utf8')
    const field = (name: string): number | null => {
      const match = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)
      return match ? Number(match[1]) : null
    }
    const total = field('MemTotal')
    const available = field('MemAvailable')
    if (!total || available === null) return UNKNOWN
    const share = (available / total) * 100
    return { state: byShare(share), available: share }
  }
  if (platform === 'win32') {
    // Node's free memory is the available physical memory on Windows.
    const share = (os.freemem() / os.totalmem()) * 100
    return { state: byShare(share), available: share }
  }
  return UNKNOWN
}

/** The rule a setting gives under a memory state; null under Never. */
export function idleRule(
  settings: IdleSessionsSettings,
  memory: MemoryState,
  totalBytes: number,
): IdleReleaseRule | null {
  if (settings.release === 'never') return null
  if (settings.release === 'custom') {
    return {
      outOfView: settings.outOfView,
      inView: settings.inView,
      limit: settings.limit,
      now: false,
    }
  }
  if (memory === 'critical') return { outOfView: 0, inView: 0, limit: 0, now: true }
  // Unknown memory keeps plenty's timings, without the cap it cannot work out.
  const limit =
    memory === 'unknown' ? null : Math.floor((totalBytes * MEMORY_SHARE) / PROCESS_BYTES)
  return memory === 'tight'
    ? { outOfView: 1, inView: 5, limit, now: false }
    : { outOfView: 15, inView: 30, limit, now: false }
}

/** What a resume's first main-thread request read of the prompt cache. */
export interface ResumeRead {
  /** The context before the session was released, in tokens. */
  before: number
  read: number
  written: number
}

/** Whether it missed: it read under half of the context the session had before. */
export function missedCache({ before, read }: ResumeRead): boolean {
  return read < before * MISS_SHARE
}

/**
 * Counts each Claude Code version's misses in a row; a hit sets them back. A version in fallback
 * stays there while an agent still runs it, so an update of Claude Code ends it.
 */
export class CacheGuard {
  private misses = new Map<string, number>()
  private held = new Set<string>()
  private running = new Map<AgentId, string>()

  /** An agent's session attached on this version; true when that ended a fallback. */
  seen(agentId: AgentId, version: string): boolean {
    if (this.running.get(agentId) === version) return false
    this.running.set(agentId, version)
    const used = new Set(this.running.values())
    let ended = false
    for (const held of this.held) {
      if (used.has(held)) continue
      this.held.delete(held)
      this.misses.delete(held)
      ended = true
    }
    return ended
  }

  /** A resume's first request on this version; true when it put the version in fallback. */
  resumed(version: string, missed: boolean): boolean {
    if (!missed) {
      this.misses.delete(version)
      return false
    }
    const misses = (this.misses.get(version) ?? 0) + 1
    this.misses.set(version, misses)
    if (misses < MISSES_FOR_FALLBACK || this.held.has(version)) return false
    this.held.add(version)
    return true
  }

  holds(version: string | null): boolean {
    return version !== null && this.held.has(version)
  }

  versions(): string[] {
    return [...this.held].sort()
  }
}

export interface IdleReleaseDeps {
  platform: Platform
  settings(): IdleSessionsSettings
  log(level: 'info' | 'warn', message: string): void
  /** The rule, the memory state or the fallback changed. */
  changed(): void
  read?: (platform: Platform) => Promise<MemoryReading>
  totalBytes?: () => number
}

export class IdleRelease {
  readonly guard = new CacheGuard()
  private memory: MemoryReading = UNKNOWN
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private failed = false

  constructor(private readonly deps: IdleReleaseDeps) {}

  /** Reads the memory now and once a minute, never waiting on it. */
  start(): void {
    if (this.timer) return
    void this.readNow()
    this.timer = setInterval(() => void this.readNow(), MEMORY_READ_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  memoryState(): MemoryState {
    return this.memory.state
  }

  rule(): IdleReleaseRule | null {
    const total = this.deps.totalBytes?.() ?? os.totalmem()
    return idleRule(this.deps.settings(), this.memory.state, total)
  }

  state(): IdleReleaseState {
    return { memory: this.memory.state, rule: this.rule(), fallback: this.guard.versions() }
  }

  /** The fallback or the setting changed: idle sessions are looked at again. */
  notify(): void {
    this.deps.changed()
  }

  private async readNow(): Promise<void> {
    if (this.reading) return
    this.reading = true
    let next: MemoryReading
    try {
      next = await (this.deps.read ?? readMemory)(this.deps.platform)
      this.failed = false
    } catch (error) {
      if (!this.failed) {
        this.deps.log('warn', `Could not read the system's memory: ${(error as Error).message}`)
      }
      this.failed = true
      next = UNKNOWN
    } finally {
      this.reading = false
    }
    // Stopped meanwhile.
    if (!this.timer) return
    const before = this.memory.state
    this.memory = next
    if (next.state === before) return
    const detail =
      next.available === null
        ? ''
        : ` (${Math.round(next.available)}% available${
            next.pressure !== undefined ? `, pressure ${next.pressure}` : ''
          })`
    this.deps.log('info', `Memory is ${next.state}${detail}, was ${before}`)
    this.deps.changed()
  }
}
