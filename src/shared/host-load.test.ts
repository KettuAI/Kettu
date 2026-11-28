import { describe, expect, it } from 'vitest'
import {
  parseHostPowerLoad,
  primaryPowerReading,
  type HostLoad,
  type HostPowerLoad,
} from './host-load'

describe('parseHostPowerLoad', () => {
  it('accepts valid whole-system, CPU, and battery power payloads', () => {
    const payload: HostPowerLoad = {
      systemWatts: 12.4,
      cpuWatts: null,
      batteryWatts: 30,
      batteryState: 'charging',
    }
    expect(parseHostPowerLoad(payload)).toEqual(payload)
  })

  it('normalizes missing optional numeric fields to null and strips batteryState when batteryWatts is null', () => {
    expect(parseHostPowerLoad({ cpuWatts: 18.5, batteryState: 'idle' })).toEqual({
      systemWatts: null,
      cpuWatts: 18.5,
      batteryWatts: null,
    })
  })

  it('allows 0 W idle battery readings without treating them as negative or missing', () => {
    expect(
      parseHostPowerLoad({
        systemWatts: 6.9,
        cpuWatts: null,
        batteryWatts: 0,
        batteryState: 'idle',
      }),
    ).toEqual({
      systemWatts: 6.9,
      cpuWatts: null,
      batteryWatts: 0,
      batteryState: 'idle',
    })
  })

  it('returns null when no reading is present or any field is invalid', () => {
    expect(parseHostPowerLoad(null)).toBeNull()
    expect(parseHostPowerLoad(undefined)).toBeNull()
    expect(parseHostPowerLoad([])).toBeNull()
    expect(parseHostPowerLoad({ systemWatts: null, cpuWatts: null, batteryWatts: null })).toBeNull()
    expect(parseHostPowerLoad({ systemWatts: -1, cpuWatts: null, batteryWatts: null })).toBeNull()
    expect(
      parseHostPowerLoad({ systemWatts: Number.NaN, cpuWatts: null, batteryWatts: null }),
    ).toBeNull()
    expect(
      parseHostPowerLoad({
        systemWatts: Number.POSITIVE_INFINITY,
        cpuWatts: null,
        batteryWatts: null,
      }),
    ).toBeNull()
    expect(
      parseHostPowerLoad({
        systemWatts: null,
        cpuWatts: null,
        batteryWatts: 10,
        batteryState: 'turbo',
      }),
    ).toBeNull()
  })
})

describe('primaryPowerReading', () => {
  it('prefers whole-system power over CPU power when both are present', () => {
    expect(
      primaryPowerReading({
        systemWatts: 24.5,
        cpuWatts: 12.1,
        batteryWatts: 10,
        batteryState: 'discharging',
      }),
    ).toEqual({ kind: 'system', watts: 24.5 })
  })

  it('labels CPU-only readings explicitly as cpu', () => {
    expect(
      primaryPowerReading({
        systemWatts: null,
        cpuWatts: 16.2,
        batteryWatts: null,
      }),
    ).toEqual({ kind: 'cpu', watts: 16.2 })
  })

  it('never promotes battery power alone to the overview header reading', () => {
    expect(
      primaryPowerReading({
        systemWatts: null,
        cpuWatts: null,
        batteryWatts: 14.8,
        batteryState: 'discharging',
      }),
    ).toBeNull()
    expect(primaryPowerReading(undefined)).toBeNull()
  })
})

describe('HostLoad wire backward compatibility', () => {
  it('omits power when unavailable and preserves power across JSON serialization', () => {
    const withoutPower: HostLoad = {
      at: 1_800_000_000_000,
      cpu: { percent: 12.3, cores: 8 },
      memory: { used: 4_000_000_000, total: 16_000_000_000, state: 'plenty' },
    }
    const parsedWithout = JSON.parse(JSON.stringify(withoutPower)) as HostLoad
    expect('power' in parsedWithout).toBe(false)

    const withPower: HostLoad = {
      ...withoutPower,
      power: {
        systemWatts: 10.3,
        cpuWatts: null,
        batteryWatts: 0,
        batteryState: 'idle',
      },
    }
    const parsedWith = JSON.parse(JSON.stringify(withPower)) as HostLoad
    expect(parseHostPowerLoad(parsedWith.power)).toEqual(withPower.power)
  })
})
