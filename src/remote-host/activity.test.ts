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
    log.record(phone, { kind: 'session-created', sessionId: 's1' })
    log.record(tablet, { kind: 'renamed', from: 'iPad', to: 'Tablet', by: 'device' })
    expect(log.list(phone)).toEqual([
      { at: 2000, kind: 'session-created', sessionId: 's1' },
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
          ],
          'not-an-id': [{ at: 9, kind: 'connected' }],
        },
      }),
    )
    const log = await ActivityLog.load(dir, quiet, () => 10)
    expect(log.list(phone)).toEqual([
      { at: 8, kind: 'removed', by: 'owner' },
      { at: 5, kind: 'connected' },
    ])
  })
})
