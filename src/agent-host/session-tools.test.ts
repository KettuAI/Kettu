import { describe, expect, it } from 'vitest'
import {
  DAILY_LIMIT,
  WORKING_LIMIT,
  canTarget,
  cutReply,
  startLimit,
  type StartCandidate,
  type ToolSession,
} from './session-tools'

const startOfDay = (now: number): number => {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const candidate = (over: Partial<StartCandidate> = {}): StartCandidate => ({
  status: 'ready',
  createdAt: 0,
  startedBy: 'caller',
  ...over,
})

describe('canTarget', () => {
  const session = (
    id: string,
    startedBy: string | null = null,
  ): Pick<ToolSession, 'id' | 'startedBy'> => ({
    id,
    startedBy,
  })

  it('takes the caller itself', () => {
    expect(canTarget(session('a'), 'a')).toBe(true)
  })

  it('takes a session the caller started', () => {
    expect(canTarget(session('b', 'a'), 'a')).toBe(true)
  })

  it('leaves out another session', () => {
    expect(canTarget(session('b'), 'a')).toBe(false)
    expect(canTarget(session('b', 'c'), 'a')).toBe(false)
  })

  it('stops at one level: a session started by a started one is out', () => {
    expect(canTarget(session('c', 'b'), 'a')).toBe(false)
    // And a started session may target only itself, never the one it runs under.
    expect(canTarget(session('a'), 'b')).toBe(false)
  })
})

describe('startLimit', () => {
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime()
  const midnight = startOfDay(now)

  it("allows three sessions working at once, and counts only the caller's", () => {
    const working = (count: number, startedBy = 'caller') =>
      Array.from({ length: count }, () => candidate({ status: 'running', startedBy }))
    expect(startLimit('caller', working(WORKING_LIMIT - 1), now)).toBeNull()
    expect(startLimit('caller', working(WORKING_LIMIT), now)).toEqual({
      kind: 'working',
      limit: WORKING_LIMIT,
    })
    // Three of another session's do not count.
    expect(startLimit('caller', working(WORKING_LIMIT, 'other'), now)).toBeNull()
    // A closed one is not working.
    expect(
      startLimit(
        'caller',
        [...working(WORKING_LIMIT - 1), candidate({ status: 'closed', createdAt: now })],
        now,
      ),
    ).toBeNull()
  })

  it('allows ten in a local day, across midnight', () => {
    const today = (count: number, createdAt = midnight + 1) =>
      Array.from({ length: count }, () => candidate({ status: 'closed', createdAt }))
    expect(startLimit('caller', today(DAILY_LIMIT - 1), now)).toBeNull()
    expect(startLimit('caller', today(DAILY_LIMIT), now)).toEqual({
      kind: 'day',
      limit: DAILY_LIMIT,
      resetsAt: startOfDay(now + 24 * 60 * 60 * 1000),
    })
    // Yesterday's are not today's.
    expect(startLimit('caller', today(DAILY_LIMIT - 1, midnight - 1), now)).toBeNull()
    // But the working limit comes first.
    expect(
      startLimit(
        'caller',
        [
          ...today(DAILY_LIMIT),
          candidate({ status: 'running', createdAt: midnight + 1 }),
          candidate({ status: 'running', createdAt: midnight + 1 }),
          candidate({ status: 'running', createdAt: midnight + 1 }),
        ],
        now,
      ),
    ).toEqual({ kind: 'working', limit: WORKING_LIMIT })
  })
})

describe('cutReply', () => {
  it('keeps a short reply whole', () => {
    expect(cutReply('One line\nTwo')).toBe('One line\nTwo')
  })

  it('cuts at a line at 8 KB', () => {
    const line = `${'x'.repeat(99)}\n`
    const reply = line.repeat(200)
    const cut = cutReply(reply)
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(cut.endsWith('\n')).toBe(false)
    expect(reply.startsWith(cut)).toBe(true)
    expect(cut.split('\n').every((part) => part.length === 99)).toBe(true)
  })

  it('keeps what fits of one line longer than the limit', () => {
    const cut = cutReply('y'.repeat(9 * 1024))
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(cut).toBe('y'.repeat(8 * 1024))
  })
})
