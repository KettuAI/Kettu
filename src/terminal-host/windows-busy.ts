// Detects whether a Windows shell has a non-helper child process running, using a single
// Win32_Process snapshot instead of node-pty's private _getConsoleProcessList (whose helper
// process attaches itself to the console and inflates the count even for an idle shell).

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { type Environment, readEnv } from './shell'

export interface WindowsProcess {
  pid: number
  parentPid: number
  name: string
}

// Console infrastructure processes attached to ConPTY or WinPTY sessions are not user commands.
const CONSOLE_HELPERS = new Set([
  'conhost',
  'openconsole',
  'winpty-agent',
  'conpty_console_list_agent',
])

// Must finish well under QuitFlow's BUSY_TIMEOUT_MS (2000 ms) even when WMI is slow.
const PROCESS_LIST_TIMEOUT_MS = 1500
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

// Single-quoted PowerShell command with no double quotes or backticks to avoid Windows argv
// escaping edge cases. Emits `ProcessId<TAB>ParentProcessId<TAB>Name` per line.
const LIST_PROCESSES_COMMAND =
  "$ProgressPreference='SilentlyContinue'; " +
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name | ' +
  "ForEach-Object { '{0}{1}{2}{1}{3}' -f $_.ProcessId,[char]9,$_.ParentProcessId,$_.Name }"

function normalizedProcessName(name: string): string {
  const base = name.trim().toLowerCase().split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|com|cmd|bat)$/i, '')
}

/** Whether `name` is a Windows console host helper rather than a command running in the shell. */
export function isConsoleHelper(name: string): boolean {
  return CONSOLE_HELPERS.has(normalizedProcessName(name))
}

/**
 * Parses tab-separated `pid\tparentPid\tname` lines from the Windows process snapshot. Returns
 * null when no valid process entries were produced (indicating enumeration failed).
 */
export function parseWindowsProcesses(output: string): WindowsProcess[] | null {
  const processes: WindowsProcess[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const [pidText, parentPidText, ...rest] = line.split('\t')
    if (pidText === undefined || parentPidText === undefined) continue
    const pid = Number(pidText)
    const parentPid = Number(parentPidText)
    if (!Number.isSafeInteger(pid) || pid < 0) continue
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) continue
    processes.push({ pid, parentPid, name: rest.join('\t').trim() })
  }
  return processes.length > 0 ? processes : null
}

/**
 * Whether `shellPid` has any descendant process other than Windows console helpers. Console helper
 * nodes are traversed transparently so commands underneath them are still detected, and cycles
 * caused by PID reuse terminate safely.
 */
export function hasRunningChildProcess(
  shellPid: number,
  processes: readonly WindowsProcess[],
): boolean {
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0) return false
  const childrenByParent = new Map<number, WindowsProcess[]>()
  for (const proc of processes) {
    if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) continue
    if (!Number.isSafeInteger(proc.parentPid) || proc.parentPid <= 0) continue
    if (proc.pid === proc.parentPid) continue
    const list = childrenByParent.get(proc.parentPid)
    if (list) list.push(proc)
    else childrenByParent.set(proc.parentPid, [proc])
  }
  const visited = new Set<number>([shellPid])
  const queue: number[] = [shellPid]
  for (let head = 0; head < queue.length; head++) {
    const children = childrenByParent.get(queue[head]!)
    if (!children) continue
    for (const child of children) {
      if (visited.has(child.pid)) continue
      visited.add(child.pid)
      if (!isConsoleHelper(child.name)) return true
      queue.push(child.pid)
    }
  }
  return false
}

/** Reads the Windows process table once via built-in Windows PowerShell; null on any failure. */
export function listWindowsProcesses(
  env: Environment = process.env,
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
): Promise<WindowsProcess[] | null> {
  const systemRoot =
    readEnv(env, 'SystemRoot', 'win32') ?? readEnv(env, 'windir', 'win32') ?? 'C:\\Windows'
  const powershell = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LIST_PROCESSES_COMMAND],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(parseWindowsProcesses(String(stdout)))
      },
    )
  })
}
