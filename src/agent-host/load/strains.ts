// When a host runs low: memory the system judges critical, a volume with a project or Kettu's data
// short of free space, or the battery low while on battery. A level counts after two reads in a
// row under its line, and ends once the reading stays back over the line, plus a margin, for five
// minutes, so a value near a line does not make the tag come and go.

import {
  BATTERY_CRITICAL_PERCENT,
  BATTERY_MARGIN_PERCENT,
  BATTERY_WARN_PERCENT,
  DISK_CRITICAL_BYTES,
  DISK_MARGIN_BYTES,
  DISK_WARN_BYTES,
  STRAIN_CLEAR_MS,
  STRAIN_READS,
  strainOrder,
  type HostLoad,
  type HostStrain,
} from '@shared/host-load'

type Level = 0 | 1 | 2
const DISK_STEP = 1e8
const LEVELS: (HostStrain['level'] | null)[] = [null, 'warn', 'critical']

/** One reading of one thing: its level by the lines, and by the lines raised by the margin. */
interface Reading {
  level: Level
  /** The level it still has while within the margin over a line. */
  held: Level
  value: number
}

/** One thing's level over time, as a run of readings moves it. */
export class StrainLevel {
  private level: Level = 0
  /** Reads in a row over the current level, and the lowest of them. */
  private over = 0
  private overLevel: Level = 0
  /** Since when the readings stayed under the current level with the margin, and their highest. */
  private underSince: number | null = null
  private underLevel: Level = 0

  get current(): Level {
    return this.level
  }

  /** Takes a reading at `now`; true when the level changed. */
  read(reading: Reading, now: number): boolean {
    if (reading.level > this.level) {
      this.overLevel =
        this.over === 0 ? reading.level : (Math.min(this.overLevel, reading.level) as Level)
      this.over++
    } else {
      this.over = 0
    }
    if (reading.held < this.level) {
      if (this.underSince === null) {
        this.underSince = now
        this.underLevel = reading.held
      } else {
        this.underLevel = Math.max(this.underLevel, reading.held) as Level
      }
    } else {
      this.underSince = null
    }
    const before = this.level
    if (this.over >= STRAIN_READS) {
      this.level = this.overLevel
      this.over = 0
      this.underSince = null
    } else if (this.underSince !== null && now - this.underSince >= STRAIN_CLEAR_MS) {
      this.level = this.underLevel
      this.underSince = null
    }
    return this.level !== before
  }

  /** Ends at once, as when the computer is plugged in. */
  clear(): boolean {
    const before = this.level
    this.level = 0
    this.over = 0
    this.underSince = null
    return before !== 0
  }
}

function byLines(value: number, warn: number, critical: number): Level {
  return value < critical ? 2 : value < warn ? 1 : 0
}

/** The strains of a run of loads, kept per memory, volume and battery. */
export class Strains {
  private memory = new StrainLevel()
  private memoryValue = 0
  private battery = new StrainLevel()
  private batteryValue = 0
  private readonly disks = new Map<string, { level: StrainLevel; value: number }>()

  /** Takes a load; true when the strains changed. */
  read(load: HostLoad): boolean {
    const now = load.at
    let changed = false
    const memoryLeft =
      load.memory.total > 0
        ? Math.round(((load.memory.total - load.memory.used) / load.memory.total) * 100)
        : 0
    const critical: Level = load.memory.state === 'critical' ? 2 : 0
    changed =
      this.memory.read({ level: critical, held: critical, value: memoryLeft }, now) || changed
    if (this.memory.current > 0 || critical) this.memoryValue = memoryLeft

    const seen = new Set<string>()
    for (const disk of load.disks) {
      seen.add(disk.path)
      let kept = this.disks.get(disk.path)
      if (!kept) {
        kept = { level: new StrainLevel(), value: disk.free }
        this.disks.set(disk.path, kept)
      }
      kept.value = disk.free
      changed =
        kept.level.read(
          {
            level: byLines(disk.free, DISK_WARN_BYTES, DISK_CRITICAL_BYTES),
            held: byLines(
              disk.free,
              DISK_WARN_BYTES + DISK_MARGIN_BYTES,
              DISK_CRITICAL_BYTES + DISK_MARGIN_BYTES,
            ),
            value: disk.free,
          },
          now,
        ) || changed
    }
    // A volume no longer read, as when its last project went, is no longer low.
    for (const [key, kept] of this.disks) {
      if (seen.has(key)) continue
      if (kept.level.current > 0) changed = true
      this.disks.delete(key)
    }

    const battery = load.battery
    if (!battery?.onBattery || battery.percent === undefined) {
      // Plugged in, the battery is no longer a worry.
      changed = this.battery.clear() || changed
    } else {
      this.batteryValue = battery.percent
      changed =
        this.battery.read(
          {
            level: byLines(battery.percent, BATTERY_WARN_PERCENT, BATTERY_CRITICAL_PERCENT),
            held: byLines(
              battery.percent,
              BATTERY_WARN_PERCENT + BATTERY_MARGIN_PERCENT,
              BATTERY_CRITICAL_PERCENT + BATTERY_MARGIN_PERCENT,
            ),
            value: battery.percent,
          },
          now,
        ) || changed
    }
    return changed
  }

  list(): HostStrain[] {
    const strains: HostStrain[] = []
    const add = (kind: HostStrain['kind'], level: Level, value: number, path?: string): void => {
      const name = LEVELS[level]
      if (name) strains.push({ kind, level: name, value, ...(path ? { path } : {}) })
    }
    add('memory', this.memory.current, this.memoryValue)
    for (const [diskPath, kept] of this.disks) {
      // To the tenth of a GB a tag shows, so a client hears of a change it would show.
      add('disk', kept.level.current, Math.round(kept.value / DISK_STEP) * DISK_STEP, diskPath)
    }
    add('battery', this.battery.current, this.batteryValue)
    return strains.sort(strainOrder)
  }
}
