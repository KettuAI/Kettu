// agy's commands that run on past the turn that started them. agy 1.5.15 ends a turn while a daemon
// it started (`IsDaemon`) still runs, its call left in progress, and reports the call once more as
// the command ends, between turns or in a later one; agy before it did the same with a command that
// went on in the background. Such a call keeps its row running and lists as a task on the session
// board. Nothing over ACP stops one command or reads its output before it ends; agy stops them all
// as the session closes.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { BackgroundTaskView } from '@shared/thread'
import { commandEnding, fromAgy } from './agy-tools'

interface Command {
  title: string
  command: string
  /** 是否以 IsDaemon 启动的常驻后台进程。 */
  daemon: boolean
  /** As agy last reported the call: `pending` while it waits for the user's permission. */
  call: acp.ToolCallStatus
  startedAt: number
  endedAt: number | null
  summary: string | null
  /** It outlived the turn that started it. */
  carried: boolean
}

function commandLine(
  update: acp.ToolCallUpdate,
): { line: string; title: string; daemon: boolean } | null {
  const input = update.rawInput
  if (typeof input !== 'object' || input === null) return null
  const {
    CommandLine: line,
    toolSummary: summary,
    IsDaemon: daemon,
  } = input as Record<string, unknown>
  if (typeof line !== 'string') return null
  return {
    line,
    title: typeof summary === 'string' && summary.trim() ? summary : line,
    daemon: daemon === true,
  }
}

function taskStatus(call: acp.ToolCallStatus): BackgroundTaskView['status'] {
  return call === 'completed' ? 'completed' : call === 'failed' ? 'failed' : 'running'
}

/** One session's commands: this turn's, and those that outlived their turn. */
export class AgyCommands {
  private readonly calls = new Map<string, Command>()

  /**
   * Follows one of agy's tool call updates: in a turn every command's, between turns only those
   * that outlived theirs. True when what the session board lists changed.
   */
  follow(update: acp.ToolCallUpdate, inTurn: boolean, now: number): boolean {
    let known = this.calls.get(update.toolCallId)
    if (!known) {
      const named = inTurn ? commandLine(update) : null
      if (!named) return false
      known = {
        title: named.title,
        command: named.line,
        daemon: named.daemon,
        call: 'pending',
        startedAt: now,
        endedAt: null,
        summary: null,
        carried: false,
      }
      this.calls.set(update.toolCallId, known)
    }
    const status = fromAgy(update).status
    if (!status || status === known.call) return false
    const ended = status === 'completed' || status === 'failed'
    if (status === 'in_progress' && known.call === 'pending') known.startedAt = now
    known.call = status
    if (ended) {
      known.endedAt = now
      known.summary = commandEnding(update) ?? known.summary
    }
    return known.carried
  }

  /**
   * 回合结束：保留仍在运行的跨回合命令；若回合异常中止，不再把未标 IsDaemon 的普通命令误留为运行中后台任务。
   */
  turnEnded(aborted = false): boolean {
    let changed = false
    for (const [id, command] of this.calls) {
      if (command.carried) continue
      if (command.call === 'in_progress' && (!aborted || command.daemon)) {
        command.carried = true
        changed = true
      } else {
        this.calls.delete(id)
      }
    }
    return changed
  }

  /** Whether one that outlived its turn still runs. */
  get running(): boolean {
    for (const command of this.calls.values()) {
      if (command.carried && command.call === 'in_progress') return true
    }
    return false
  }

  /** What the session board lists: the commands that outlived their turn, oldest first. */
  tasks(): BackgroundTaskView[] {
    return [...this.calls]
      .filter(([, command]) => command.carried)
      .map(([toolCallId, command]) => ({
        id: toolCallId,
        kind: 'shell',
        title: command.title,
        command: command.command,
        status: taskStatus(command.call),
        startedAt: command.startedAt,
        endedAt: command.endedAt,
        summary: command.summary,
        entryId: `t:${toolCallId}`,
      }))
  }
}
