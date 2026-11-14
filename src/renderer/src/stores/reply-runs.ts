import { create } from 'zustand'
import { plainTail } from '@shared/terminal-text'

// The code blocks the user ran from replies, by session and command, in this window's memory: the
// terminal each runs in, when it started and ended, and its last lines for the block's bar. The
// terminals store feeds it each run terminal's output and info, from the terminal's first output
// on, since the host announces the terminal and its output before it answers the run.

export interface ReplyRun {
  terminalId: string
  /** Whether the agent was told, which Run again keeps. */
  notify: boolean
  startedAt: number
  endedAt: number | null
  tail: string
}

interface ReplyRunsStore {
  byKey: Record<string, ReplyRun>
  /** Blocks whose run waits on the host. */
  starting: Record<string, true>
  /** What went wrong with a block's last run, under its bar until it runs again. */
  problems: Record<string, string>
}

export const useReplyRunsStore = create<ReplyRunsStore>()(() => ({
  byKey: {},
  starting: {},
  problems: {},
}))

const TAIL_LINES = 3
const RAW_CHARS = 4096
const TAIL_EVERY_MS = 150
// A command quicker than the host's look at the foreground never shows as busy; once this long
// has passed without it, it has ended. Windows tells no foreground, so there it never ends early.
const QUICK_END_MS = 1500

const keyOf = new Map<string, string>() // terminal id -> its run's key
const raw = new Map<string, string>() // run terminal id -> its latest output
const sawBusy = new Set<string>()
const busyNow = new Set<string>()
const tailTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function replyRunKey(sessionId: string, command: string): string {
  return `${sessionId}\n${command}`
}

function update(key: string, change: Partial<ReplyRun>): void {
  useReplyRunsStore.setState((s) => {
    const run = s.byKey[key]
    return run ? { byKey: { ...s.byKey, [key]: { ...run, ...change } } } : s
  })
}

/** Notes what went wrong with a block's run, or clears it with null. */
export function replyRunProblem(key: string, problem: string | null): void {
  useReplyRunsStore.setState((s) => {
    if ((s.problems[key] ?? null) === problem) return s
    const problems = { ...s.problems }
    if (problem === null) delete problems[key]
    else problems[key] = problem
    return { problems }
  })
}

export function replyRunStarting(key: string, starting: boolean): void {
  useReplyRunsStore.setState((s) => {
    if (starting === key in s.starting) return s
    const next = { ...s.starting }
    if (starting) next[key] = true
    else delete next[key]
    return { starting: next }
  })
}

/** A terminal the host opened for a run from a reply, before the run's answer names it. */
export function replyRunTerminal(terminalId: string): void {
  if (!raw.has(terminalId)) raw.set(terminalId, '')
}

/**
 * A block's run began in `terminalId`; an earlier run of the same block is no longer followed.
 * `knowsBusy` is false on a Windows host, which tells no foreground process.
 */
export function replyRunStarted(
  key: string,
  terminalId: string,
  notify: boolean,
  knowsBusy: boolean,
): void {
  const before = useReplyRunsStore.getState().byKey[key]
  if (before && before.terminalId !== terminalId) forget(before.terminalId)
  keyOf.set(terminalId, key)
  const tail = plainTail(raw.get(terminalId) ?? '', TAIL_LINES)
  if (!raw.has(terminalId)) raw.set(terminalId, '')
  useReplyRunsStore.setState((s) => ({
    byKey: {
      ...s.byKey,
      [key]: { terminalId, notify, startedAt: Date.now(), endedAt: null, tail },
    },
  }))
  // A quick command can be over before the run's answer.
  if (sawBusy.has(terminalId) && !busyNow.has(terminalId)) {
    update(key, { endedAt: Date.now() })
    return
  }
  if (!knowsBusy) return
  setTimeout(() => {
    const run = useReplyRunsStore.getState().byKey[key]
    if (run?.terminalId === terminalId && !sawBusy.has(terminalId) && !busyNow.has(terminalId)) {
      update(key, { endedAt: Date.now() })
    }
  }, QUICK_END_MS)
}

/** A run terminal printed: its bar's last lines follow, a few times a second at most. */
export function replyRunData(terminalId: string, data: string): void {
  const before = raw.get(terminalId)
  if (before === undefined) return
  raw.set(terminalId, (before + data).slice(-RAW_CHARS))
  if (tailTimers.has(terminalId)) return
  tailTimers.set(
    terminalId,
    setTimeout(() => {
      tailTimers.delete(terminalId)
      const key = keyOf.get(terminalId)
      if (key) update(key, { tail: plainTail(raw.get(terminalId) ?? '', TAIL_LINES) })
    }, TAIL_EVERY_MS),
  )
}

/** A run terminal's host told its state: the run ends when its command leaves the foreground. */
export function replyRunInfo(terminalId: string, busy: boolean, exitCode: number | null): void {
  if (!raw.has(terminalId)) return
  if (busy) {
    sawBusy.add(terminalId)
    busyNow.add(terminalId)
    return
  }
  busyNow.delete(terminalId)
  const key = keyOf.get(terminalId)
  const run = key ? useReplyRunsStore.getState().byKey[key] : undefined
  if (key && run && run.endedAt === null && (sawBusy.has(terminalId) || exitCode !== null)) {
    update(key, { endedAt: Date.now() })
  }
}

function forget(terminalId: string): void {
  keyOf.delete(terminalId)
  raw.delete(terminalId)
  sawBusy.delete(terminalId)
  busyNow.delete(terminalId)
  const timer = tailTimers.get(terminalId)
  if (timer) clearTimeout(timer)
  tailTimers.delete(terminalId)
}

/** A run terminal closed: its block keeps the run, which shows the terminal as closed. */
export function replyRunClosed(terminalId: string): void {
  const key = keyOf.get(terminalId)
  forget(terminalId)
  const run = key ? useReplyRunsStore.getState().byKey[key] : undefined
  if (key && run && run.endedAt === null) update(key, { endedAt: Date.now() })
}
