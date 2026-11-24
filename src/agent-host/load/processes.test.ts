import { describe, expect, it } from 'vitest'
import {
  attributeUsage,
  parseBootTime,
  parseProcProcess,
  parsePsUsage,
  programName,
  psSeconds,
  type ProcessSample,
  type UsageOwners,
} from './processes'

const NOW = 1_800_000_000_000
const MB = 1024 ** 2

describe('psSeconds', () => {
  it('reads cumulative CPU time and elapsed time', () => {
    expect(psSeconds('0:01.55')).toBe(1.55)
    expect(psSeconds('920:02.68')).toBeCloseTo(920 * 60 + 2.68)
    expect(psSeconds('01:02:03')).toBe(3723)
    expect(psSeconds('24-21:03:19')).toBe(((24 * 24 + 21) * 60 + 3) * 60 + 19)
    expect(psSeconds('soon')).toBeNull()
  })
})

describe('programName', () => {
  it('folds an app and its helpers into the app', () => {
    expect(
      programName(
        '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
      ),
    ).toBe('Google Chrome')
    expect(programName('/Applications/Xcode.app/Contents/MacOS/Xcode')).toBe('Xcode')
  })

  it('names other programs by their file alone, never the folders around it', () => {
    expect(programName('/Users/someone/.local/bin/claude')).toBe('claude')
    expect(programName('/usr/libexec/logd')).toBe('logd')
    expect(programName('node')).toBe('node')
  })
})

describe('parsePsUsage', () => {
  it('reads each row, and a program path with spaces whole', () => {
    const rows = parsePsUsage(
      [
        '    1     0     1     0  18416 405:22.59 24-21:03:19 /sbin/launchd',
        '  274     1   274   501   9584   0:01.67 01-05:56:04 /Applications/Keka.app/Contents/PlugIns/KekaFinderIntegration.appex/Contents/MacOS/KekaFinderIntegration',
        'garbage',
      ].join('\n'),
      NOW,
    )
    expect(rows).toEqual([
      {
        pid: 1,
        ppid: 0,
        pgid: 1,
        uid: 0,
        rss: 18416 * 1024,
        cpuMs: Math.round((405 * 60 + 22.59) * 1000),
        startedAt: NOW - (((24 * 24 + 21) * 60 + 3) * 60 + 19) * 1000,
        name: 'launchd',
      },
      {
        pid: 274,
        ppid: 1,
        pgid: 274,
        uid: 501,
        rss: 9584 * 1024,
        cpuMs: 1670,
        startedAt: NOW - ((1 * 24 + 5) * 3600 + 56 * 60 + 4) * 1000,
        name: 'Keka',
      },
    ])
  })
})

describe('parseProcProcess', () => {
  const BOOT = NOW - 3_600_000
  const status = 'Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t  204800 kB\n'

  it('reads the parent, group, CPU ticks, start and memory', () => {
    // A name with spaces and a closing parenthesis, as a program may give itself.
    const stat =
      '4242 (Web Content (x)) S 4100 4100 4100 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 360000 1000000 51200 18446744073709551615'
    expect(parseProcProcess(stat, status, BOOT)).toEqual({
      pid: 4242,
      ppid: 4100,
      pgid: 4100,
      startedAt: BOOT + 3_600_000,
      uid: 1000,
      rss: 204800 * 1024,
      cpuMs: 3000,
      name: 'Web Content (x)',
    })
  })

  it('takes a kernel thread without memory', () => {
    const stat = '2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 1 0 0 20 0 1 0 2 0 0'
    expect(parseProcProcess(stat, 'Name:\tkthreadd\nUid:\t0\t0\t0\t0\n', BOOT)?.rss).toBe(0)
  })

  it('refuses a line it cannot read', () => {
    expect(parseProcProcess('', status, BOOT)).toBeNull()
    expect(parseProcProcess('12 (x) S', status, BOOT)).toBeNull()
  })
})

describe('parseBootTime', () => {
  it('reads btime', () => {
    expect(parseBootTime('cpu  1 2 3\nbtime 1700000000\nprocesses 9\n')).toBe(1_700_000_000_000)
    expect(parseBootTime('cpu 1 2')).toBeNull()
  })
})

function row(
  pid: number,
  ppid: number,
  cpuMs: number,
  rssMb: number,
  name: string,
  extra: Partial<ProcessSample> = {},
): ProcessSample {
  return {
    pid,
    ppid,
    pgid: extra.pgid ?? pid,
    startedAt: extra.startedAt ?? NOW - 600_000,
    uid: extra.uid ?? 501,
    rss: rssMb * MB,
    cpuMs,
    name,
  }
}

const OWNERS: UsageOwners = {
  kettu: 100,
  daemon: false,
  sessions: [{ sessionId: 's1', pids: [300] }],
  agents: [{ agentId: 'codex', sessions: 2, pids: [400] }],
  terminals: [{ terminalId: 't1', sessionId: 's1', name: 'pnpm dev', pid: 500 }],
  uid: null,
}

describe('attributeUsage', () => {
  // 4 cores over 1 s: 40 ms of CPU is 1% of the computer.
  const before = {
    at: NOW,
    rows: [
      row(100, 1, 1000, 0, 'Electron'),
      row(200, 100, 1000, 0, 'Kettu Helper'),
      row(300, 200, 1000, 0, 'claude'),
      row(301, 300, 0, 0, 'node', { pgid: 301 }),
      row(400, 200, 1000, 0, 'codex'),
      row(500, 200, 1000, 0, 'zsh'),
      row(501, 500, 1000, 0, 'node'),
      row(600, 1, 1000, 0, 'Xcode'),
      row(700, 1, 1000, 0, 'Docker'),
      row(701, 1, 1000, 0, 'Docker'),
      row(800, 1, 1000, 0, 'Safari'),
      row(900, 1, 1000, 0, 'Finder'),
    ],
  }
  const after = {
    at: NOW + 1000,
    rows: [
      row(100, 1, 1040, 300, 'Electron'),
      row(200, 100, 1040, 100, 'Kettu Helper'),
      row(300, 200, 1400, 200, 'claude'),
      // A command the agent runs in a group of its own, reparented away from it.
      row(301, 1, 40, 50, 'node', { pgid: 300 }),
      row(400, 200, 1080, 150, 'codex'),
      row(500, 200, 1000, 10, 'zsh'),
      row(501, 500, 1200, 400, 'node'),
      // Started during the interval: all its time counts.
      row(502, 501, 40, 20, 'esbuild', { startedAt: NOW + 500 }),
      row(600, 1, 1440, 4000, 'Xcode'),
      row(700, 1, 1080, 1000, 'Docker'),
      row(701, 1, 1080, 1000, 'Docker'),
      row(800, 1, 1040, 3000, 'Safari'),
      row(900, 1, 1000, 100, 'Finder'),
    ],
  }
  const totals = { cpu: 50, memory: 20_000 * MB, cores: 4 }

  it('gives each process to one owner, and names the top programs', () => {
    const usage = attributeUsage(before, after, OWNERS, totals, 'darwin')
    expect(usage.terminals).toEqual([
      { terminalId: 't1', sessionId: 's1', name: 'pnpm dev', cpu: 6, memory: 430 * MB },
    ])
    expect(usage.sessions).toEqual([{ sessionId: 's1', processes: 2, cpu: 11, memory: 250 * MB }])
    expect(usage.agents).toEqual([
      { agentId: 'codex', sessions: 2, processes: 1, cpu: 2, memory: 150 * MB },
    ])
    expect(usage.kettu).toEqual({ cpu: 2, memory: 400 * MB })
    // Docker's two processes as one; Finder is neither in the top 3 by CPU nor by memory.
    expect(usage.others).toEqual([
      { name: 'Xcode', cpu: 11, memory: 4000 * MB },
      { name: 'Docker', cpu: 4, memory: 2000 * MB },
      { name: 'Safari', cpu: 1, memory: 3000 * MB },
    ])
    expect(usage.rest).toEqual({ cpu: 13, memory: (20_000 - 10_230) * MB })
  })

  it('lists another top program by memory beside those by CPU', () => {
    const big = {
      ...after,
      rows: after.rows.map((r) => (r.pid === 900 ? { ...r, rss: 9000 * MB } : r)),
    }
    const usage = attributeUsage(before, big, OWNERS, totals, 'darwin')
    expect(usage.others.map((o) => o.name)).toEqual(['Xcode', 'Docker', 'Safari', 'Finder'])
  })

  it("names only the user's own programs on Linux, the rest counting in the total", () => {
    const owners = { ...OWNERS, uid: 501 }
    const others = {
      ...after,
      rows: after.rows.map((r) => (r.pid === 600 ? { ...r, uid: 0 } : r)),
    }
    const usage = attributeUsage(before, others, owners, totals, 'linux')
    expect(usage.others.map((o) => o.name)).toEqual(['Docker', 'Safari', 'Finder'])
    expect(usage.rest.cpu).toBe(24)
  })

  it('leaves out a session whose agent is gone, and never counts a reused pid', () => {
    const reused = {
      ...after,
      rows: after.rows
        .filter((r) => r.pid !== 300 && r.pid !== 301)
        .map((r) =>
          r.pid === 600 ? { ...r, startedAt: NOW - 2 * 3_600_000 + 1, cpuMs: 99_999 } : r,
        ),
    }
    const shifted = {
      ...before,
      rows: before.rows.map((r) => (r.pid === 600 ? { ...r, startedAt: NOW - 3_600_000 } : r)),
    }
    const usage = attributeUsage(shifted, reused, OWNERS, totals, 'darwin')
    expect(usage.sessions).toEqual([])
    expect(usage.others.find((o) => o.name === 'Xcode')?.cpu).toBe(0)
  })
})
