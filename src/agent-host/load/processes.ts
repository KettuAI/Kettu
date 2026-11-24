// What uses the computer: one listing of its processes, `ps` on macOS and `/proc` on Linux, split
// into Kettu's sessions, terminals and itself, and the other programs by name. Only names are
// read, never arguments or environment, which often hold tokens.

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentId } from '@shared/agents'
import type { HostLoadUsage, LoadUse } from '@shared/host-load'
import type { Platform } from '@shared/platform'
import { descendantsOf, START_SLACK_MS, treeOf, type ProcessRow } from '../process-tree'
import { CLOCK_TICKS } from './system'

export interface ProcessSample extends ProcessRow {
  /** The owner's user id; null where it is not read. */
  uid: number | null
  /** Resident memory in bytes. */
  rss: number
  /** CPU time used since it started, in milliseconds. */
  cpuMs: number
  /** The program: its .app on macOS, its executable's name otherwise. */
  name: string
}

/** `[[dd-]hh:]mm:ss[.cc]` as seconds; `time` and `etime` of `ps` both take this form. */
export function psSeconds(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text)
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  )
}

/**
 * A program's name from its path as `ps` gives it on macOS: the outermost `.app` it is inside, so
 * that an app's helpers count as the app, else the file's name.
 */
export function programName(command: string): string {
  const app = /(?:^|\/)([^/]+)\.app(?:\/|$)/.exec(command)
  if (app) return app[1]!
  const base = command.slice(command.lastIndexOf('/') + 1).trim()
  return base || command.trim()
}

/** `ps -A -o pid=,ppid=,pgid=,uid=,rss=,time=,etime=,comm=` with the C locale. */
export function parsePsUsage(text: string, now: number): ProcessSample[] {
  const rows: ProcessSample[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const [, pid, ppid, pgid, uid, rss, time, etime, comm] = match
    const cpu = psSeconds(time!)
    const elapsed = psSeconds(etime!)
    if (cpu === null || elapsed === null) continue
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      startedAt: now - elapsed * 1000,
      uid: Number(uid),
      rss: Number(rss) * 1024,
      cpuMs: Math.round(cpu * 1000),
      name: programName(comm!),
    })
  }
  return rows
}

/**
 * One process from Linux's `/proc/<pid>/stat` and `/proc/<pid>/status`, its start counted from
 * `bootMs`; null for a line that does not parse, as of a process that ended while being read.
 */
export function parseProcProcess(
  stat: string,
  status: string,
  bootMs: number,
): ProcessSample | null {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(stat.slice(0, open).trim())
  const name = stat.slice(open + 1, close)
  // From the state on: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
  // utime stime cutime cstime priority nice threads itrealvalue starttime.
  const fields = stat.slice(close + 2).split(' ')
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const ticks = Number(fields[11]) + Number(fields[12])
  const start = Number(fields[19])
  const uid = /^Uid:\s+(\d+)/m.exec(status)
  const rss = /^VmRSS:\s+(\d+)\s*kB/m.exec(status)
  if (![pid, ppid, pgid, ticks, start].every(Number.isFinite)) return null
  return {
    pid,
    ppid,
    pgid,
    startedAt: bootMs + (start / CLOCK_TICKS) * 1000,
    uid: uid ? Number(uid[1]) : null,
    // Kernel threads have no VmRSS.
    rss: rss ? Number(rss[1]) * 1024 : 0,
    cpuMs: (ticks / CLOCK_TICKS) * 1000,
    name,
  }
}

/** `/proc/stat`'s boot time, in milliseconds since the epoch. */
export function parseBootTime(text: string): number | null {
  const match = /^btime\s+(\d+)/m.exec(text)
  return match ? Number(match[1]) * 1000 : null
}

async function listProc(): Promise<ProcessSample[]> {
  const bootMs = parseBootTime(await readFile('/proc/stat', 'utf8'))
  if (bootMs === null) throw new Error('/proc/stat has no boot time')
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  const rows = await Promise.all(
    pids.map(async (pid) => {
      const dir = path.join('/proc', pid)
      const [stat, status] = await Promise.all([
        readFile(path.join(dir, 'stat'), 'utf8').catch(() => null),
        readFile(path.join(dir, 'status'), 'utf8').catch(() => null),
      ])
      return stat && status ? parseProcProcess(stat, status, bootMs) : null
    }),
  )
  return rows.filter((row): row is ProcessSample => row !== null)
}

function listPs(): Promise<ProcessSample[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-A', '-o', 'pid=,ppid=,pgid=,uid=,rss=,time=,etime=,comm='],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => (error ? reject(error) : resolve(parsePsUsage(stdout, Date.now()))),
    )
  })
}

/** Every process, or null where it is not read: Windows for now. */
export function listProcesses(platform: Platform): Promise<ProcessSample[]> | null {
  if (platform === 'darwin') return listPs()
  if (platform === 'linux') return listProc()
  return null
}

/** A listing, and when it was taken. */
export interface Listing {
  at: number
  rows: ProcessSample[]
}

/** What the host knows of the processes it runs, to name them. */
export interface UsageOwners {
  /** The app's main process or the daemon: Kettu is it and everything under it left over. */
  kettu: number
  daemon: boolean
  /** Each attached session's own agent processes. */
  sessions: { sessionId: string; pids: number[] }[]
  /** An agent's processes that several sessions share. */
  agents: { agentId: AgentId; sessions: number; pids: number[] }[]
  terminals: { terminalId: string; sessionId: string | null; name: string; pid: number }[]
  /** On Linux, only this user's programs are named; the others count in the rest. */
  uid: number | null
}

/** The whole computer over the same time as the two listings: its CPU and used memory. */
export interface UsageTotals {
  cpu: number
  memory: number
  cores: number
}

/** The programs named among the others: this many by CPU and this many by memory. */
export const TOP_OTHERS = 3

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * Splits the computer's use between what Kettu runs and the other programs, from two listings a
 * few seconds apart: a process's CPU is the time it used between them as a share of the whole
 * computer, its memory its resident size now. Each process counts once, in the first place that
 * claims it: a terminal, a session, an agent shared by sessions, then Kettu.
 */
export function attributeUsage(
  before: Listing,
  after: Listing,
  owners: UsageOwners,
  totals: UsageTotals,
  platform: Platform,
): HostLoadUsage {
  const elapsed = Math.max(1, after.at - before.at)
  const previous = new Map(before.rows.map((row) => [row.pid, row]))
  const cpuOf = (row: ProcessSample): number => {
    const was = previous.get(row.pid)
    let used: number
    if (was && Math.abs(was.startedAt - row.startedAt) <= START_SLACK_MS) {
      used = Math.max(0, row.cpuMs - was.cpuMs)
    } else {
      // Not listed before: started since, when all its time is in the interval; else unknown.
      used = row.startedAt >= before.at - START_SLACK_MS ? row.cpuMs : 0
    }
    return (used / (elapsed * Math.max(1, totals.cores))) * 100
  }
  const rows = after.rows
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const claimed = new Set<number>()
  const claim = (members: Iterable<ProcessSample>): { use: LoadUse; count: number } => {
    const use = { cpu: 0, memory: 0 }
    let count = 0
    for (const row of members) {
      if (claimed.has(row.pid)) continue
      claimed.add(row.pid)
      use.cpu += cpuOf(row)
      use.memory += row.rss
      count++
    }
    return { use: { cpu: round1(use.cpu), memory: use.memory }, count }
  }
  const tree = (pid: number): ProcessSample[] => {
    const root = byPid.get(pid)
    if (!root) return []
    const members = treeOf(rows, root, platform) as ProcessSample[]
    // The tree leaves out this process, which is never an agent's.
    return members.includes(root) ? members : [root, ...members]
  }
  const below = (pid: number): ProcessSample[] => {
    const root = byPid.get(pid)
    return root ? [root, ...(descendantsOf(rows, pid) as ProcessSample[])] : []
  }

  const terminals = owners.terminals.flatMap((terminal) => {
    const { use, count } = claim(below(terminal.pid))
    if (count === 0) return []
    return [
      {
        terminalId: terminal.terminalId,
        sessionId: terminal.sessionId,
        name: terminal.name,
        ...use,
      },
    ]
  })
  const sessions = owners.sessions.flatMap((session) => {
    const { use, count } = claim(session.pids.flatMap(tree))
    if (count === 0) return []
    return [{ sessionId: session.sessionId, processes: count, ...use }]
  })
  const agents = owners.agents.flatMap((agent) => {
    const { use, count } = claim(agent.pids.flatMap(tree))
    if (count === 0) return []
    return [{ agentId: agent.agentId, sessions: agent.sessions, processes: count, ...use }]
  })
  const kettu = {
    ...claim(owners.kettu > 1 ? below(owners.kettu) : below(process.pid)).use,
    ...(owners.daemon ? { daemon: true as const } : {}),
  }

  const named = new Map<string, LoadUse>()
  for (const row of rows) {
    if (claimed.has(row.pid) || row.pid === 0) continue
    if (owners.uid !== null && row.uid !== owners.uid) continue
    const use = named.get(row.name) ?? { cpu: 0, memory: 0 }
    use.cpu += cpuOf(row)
    use.memory += row.rss
    named.set(row.name, use)
  }
  const entries = [...named].map(([name, use]) => ({
    name,
    cpu: round1(use.cpu),
    memory: use.memory,
  }))
  const top = new Set([
    ...[...entries].sort((a, b) => b.cpu - a.cpu || b.memory - a.memory).slice(0, TOP_OTHERS),
    ...[...entries].sort((a, b) => b.memory - a.memory || b.cpu - a.cpu).slice(0, TOP_OTHERS),
  ])
  const others = [...top].sort((a, b) => b.cpu - a.cpu || b.memory - a.memory)

  const listed = [kettu, ...sessions, ...agents, ...terminals, ...others]
  const sum = (key: keyof LoadUse): number => listed.reduce((total, use) => total + use[key], 0)
  return {
    kettu,
    sessions,
    agents,
    terminals,
    others,
    rest: {
      cpu: round1(Math.max(0, totals.cpu - sum('cpu'))),
      memory: Math.max(0, Math.round(totals.memory - sum('memory'))),
    },
  }
}
