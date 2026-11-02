import { describe, expect, it, vi } from 'vitest'
import type { HostConnection, HostStatus } from '@shared/remote/hosts'

vi.stubGlobal('window', { kettu: { platform: 'darwin', client: 'desktop' } })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const { allowsTerminal, noteTerminalHosts } = await import('./hosts')

const studio = 'a'.repeat(32)
const at = { host: '192.168.1.8', port: 47821 }
const host = (connection: HostConnection) => ({ id: studio, connection }) as HostStatus

describe('allowsTerminal', () => {
  it("follows another host's word, and keeps it while the host connects again", () => {
    expect(allowsTerminal(null)).toBe(true)
    expect(allowsTerminal(studio)).toBe(false)
    noteTerminalHosts([host({ state: 'online', address: at, terminal: true })])
    expect(allowsTerminal(studio)).toBe(true)
    noteTerminalHosts([host({ state: 'connecting' })])
    expect(allowsTerminal(studio)).toBe(true)
    noteTerminalHosts([host({ state: 'online', address: at })])
    expect(allowsTerminal(studio)).toBe(false)
  })

  it('takes it back from a host that is offline or no longer known', () => {
    noteTerminalHosts([host({ state: 'online', address: at, terminal: true })])
    noteTerminalHosts([host({ state: 'offline' })])
    expect(allowsTerminal(studio)).toBe(false)
    noteTerminalHosts([host({ state: 'online', address: at, terminal: true })])
    noteTerminalHosts([])
    expect(allowsTerminal(studio)).toBe(false)
  })

  it('names the hosts that allow it again while connected, whose terminals attach again', () => {
    const online = (terminal: boolean) =>
      host({ state: 'online', address: at, ...(terminal ? { terminal: true } : {}) })
    noteTerminalHosts([])
    expect(noteTerminalHosts([online(false)])).toEqual([])
    expect(noteTerminalHosts([online(true)])).toEqual([studio])
    expect(noteTerminalHosts([online(true)])).toEqual([])
    // A new connection attaches its terminals as it opens.
    noteTerminalHosts([host({ state: 'offline' })])
    expect(noteTerminalHosts([online(true)])).toEqual([])
    noteTerminalHosts([online(false)])
    noteTerminalHosts([host({ state: 'connecting' })])
    expect(noteTerminalHosts([online(true)])).toEqual([])
  })
})
