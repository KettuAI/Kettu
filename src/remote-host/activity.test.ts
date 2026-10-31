import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempFolder } from '../agent-host/testing/temp'
import { ActivityLog } from './activity'

const DAY = 24 * 60 * 60 * 1000
const quiet = (): void => {}
const phone = 'a'.repeat(32)
const tablet = 'b'.repeat(32)

describe('ActivityLog', () => {
  it("keeps each device's events, newest first, across loads", async () => {
    const dir = await tempFolder('kettu-activity-')
    let now = 1000
    const log = await ActivityLog.load(dir, quiet, () => now)
    log.record(phone, { kind: 'paired' })
    now = 2000
    log.record(phone, { kind: 'connected' })
    log.record(phone, { kind: 'session-created', sessionId: 's1', title: null })
    log.record(phone, { kind: 'terminal-opened', projectPath: '/work/app' })
    log.record(phone, { kind: 'terminal-closed', projectPath: '/work/app' })
    log.record(tablet, { kind: 'renamed', from: 'iPad', to: 'Tablet', by: 'device' })
    expect(log.list(phone)).toEqual([
      { at: 2000, kind: 'terminal-closed', projectPath: '/work/app' },
      { at: 2000, kind: 'terminal-opened', projectPath: '/work/app' },
      { at: 2000, kind: 'session-created', sessionId: 's1', title: null },
      { at: 2000, kind: 'connected' },
      { at: 1000, kind: 'paired' },
    ])
    await log.flush()
    const reloaded = await ActivityLog.load(dir, quiet, () => now)
    expect(reloaded.list(phone)).toEqual(log.list(phone))
    expect(reloaded.list(tablet)).toEqual([
      { at: 2000, kind: 'renamed', from: 'iPad', to: 'Tablet', by: 'device' },
    ])
    expect(reloaded.list('c'.repeat(32))).toEqual([])
  })

  it('keeps 30 days and at most 500 events of a device', async () => {
    const dir = await tempFolder('kettu-activity-')
    let now = 0
    const log = await ActivityLog.load(dir, quiet, () => now)
    log.record(tablet, { kind: 'paired' })
    for (let i = 0; i < 510; i++) {
      now = 10 * DAY + i
      log.record(phone, { kind: 'connected' })
    }
    const events = log.list(phone)
    expect(events).toHaveLength(500)
    expect(events.at(-1)!.at).toBe(10 * DAY + 10)
    // Thirty days on, the tablet's pairing has gone; the phone's events go as they turn 30.
    now = 30 * DAY + 5
    expect(log.list(tablet)).toEqual([])
    expect(log.list(phone)).toHaveLength(500)
    now = 40 * DAY + 505
    expect(log.list(phone)).toHaveLength(5)
    await log.flush()
    const file = JSON.parse(await readFile(path.join(dir, 'remote', 'activity.json'), 'utf8'))
    expect(Object.keys(file.devices)).toEqual([phone])
  })

  it('keeps a session under the title it had then', async () => {
    const dir = await tempFolder('kettu-activity-')
    const log = await ActivityLog.load(dir, quiet, () => 1000)
    log.record(phone, { kind: 'session-archived', sessionId: 's1', title: 'Fix the login' })
    log.record(phone, { kind: 'session-deleted', sessionId: 's2', title: 'x'.repeat(300) })
    await log.flush()
    const reloaded = await ActivityLog.load(dir, quiet, () => 1000)
    expect(reloaded.list(phone)).toEqual([
      // Cut as long as a session's own title may be.
      { at: 1000, kind: 'session-deleted', sessionId: 's2', title: 'x'.repeat(200) },
      { at: 1000, kind: 'session-archived', sessionId: 's1', title: 'Fix the login' },
    ])
  })

  it('logs a device connecting again within 10 minutes of its last session as no new one', async () => {
    const dir = await tempFolder('kettu-activity-')
    let now = 0
    const log = await ActivityLog.load(dir, quiet, () => now)
    const connections = () => log.list(phone).filter((event) => event.kind === 'connected')
    log.opened(phone)
    now = 30 * 60_000
    log.closed(phone)
    // A flaky network: back after a few minutes, and again before the old session is noticed gone.
    now += 9 * 60_000
    log.opened(phone)
    log.opened(phone)
    log.closed(phone)
    now += 60 * 60_000
    log.closed(phone)
    expect(connections()).toEqual([{ at: 0, kind: 'connected' }])
    // Ten minutes after the last session ended, it is a new connection.
    now += 10 * 60_000
    log.opened(phone)
    expect(connections()).toEqual([
      { at: now, kind: 'connected' },
      { at: 0, kind: 'connected' },
    ])
    // Each device on its own.
    log.opened(tablet)
    expect(log.list(tablet)).toEqual([{ at: now, kind: 'connected' }])
  })

  it('keeps a terminal open across a session that ends and comes back within 10 minutes', async () => {
    const dir = await tempFolder('kettu-activity-')
    let now = 1000
    const log = await ActivityLog.load(dir, quiet, () => now)
    const terminals = () => log.list(phone).filter((event) => event.kind.startsWith('terminal-'))
    log.terminalOpened(phone, 't1', '/work/app')
    log.terminalOpened(phone, 't2', '/work/api')
    // The session ends with both open; the device is back for t1 within 10 minutes.
    now = 2000
    log.terminalClosed(phone, 't1', '/work/app', true)
    log.terminalClosed(phone, 't2', '/work/api', true)
    now += 9 * 60_000
    log.terminalOpened(phone, 't1', '/work/app')
    expect(terminals()).toEqual([
      { at: 1000, kind: 'terminal-opened', projectPath: '/work/api' },
      { at: 1000, kind: 'terminal-opened', projectPath: '/work/app' },
    ])
    // t2 is not back within 10 minutes: closed when the session ended, before what came since.
    now += 60_000
    log.record(phone, { kind: 'connected' })
    expect(log.list(phone)).toEqual([
      { at: now, kind: 'connected' },
      { at: 2000, kind: 'terminal-closed', projectPath: '/work/api' },
      { at: 1000, kind: 'terminal-opened', projectPath: '/work/api' },
      { at: 1000, kind: 'terminal-opened', projectPath: '/work/app' },
    ])
    // Opening it later is a new opening; killing one is noted at once.
    log.terminalOpened(phone, 't2', '/work/api')
    log.terminalClosed(phone, 't1', '/work/app', false)
    expect(terminals().slice(0, 2)).toEqual([
      { at: now, kind: 'terminal-closed', projectPath: '/work/app' },
      { at: now, kind: 'terminal-opened', projectPath: '/work/api' },
    ])
    // A session that ends as the host stops leaves its terminals closed in the file.
    log.terminalClosed(phone, 't2', '/work/api', true)
    await log.flush()
    const reloaded = await ActivityLog.load(dir, quiet, () => now)
    expect(reloaded.list(phone)[0]).toEqual({
      at: now,
      kind: 'terminal-closed',
      projectPath: '/work/api',
    })
  })

  it('drops events it cannot read and keeps the rest', async () => {
    const dir = await tempFolder('kettu-activity-')
    await mkdir(path.join(dir, 'remote'))
    await writeFile(
      path.join(dir, 'remote', 'activity.json'),
      JSON.stringify({
        version: 1,
        devices: {
          [phone]: [
            { at: 5, kind: 'connected' },
            { at: 6, kind: 'typed', text: 'secret' },
            { at: 7, kind: 'renamed', from: 'A', to: '', by: 'owner' },
            { at: 8, kind: 'removed', by: 'owner' },
            { at: 8, kind: 'terminal-opened' },
            { at: 8, kind: 'terminal-closed', projectPath: 7 },
            // Kept before titles were.
            { at: 9, kind: 'session-archived', sessionId: 's1' },
            { at: 9, kind: 'session-deleted', sessionId: 's2', title: 7 },
          ],
          'not-an-id': [{ at: 9, kind: 'connected' }],
        },
      }),
    )
    const log = await ActivityLog.load(dir, quiet, () => 10)
    expect(log.list(phone)).toEqual([
      { at: 9, kind: 'session-archived', sessionId: 's1', title: null },
      { at: 8, kind: 'removed', by: 'owner' },
      { at: 5, kind: 'connected' },
    ])
  })
})
