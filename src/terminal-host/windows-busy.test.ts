import { describe, expect, it } from 'vitest'
import {
  hasRunningChildProcess,
  isConsoleHelper,
  parseWindowsProcesses,
  type WindowsProcess,
} from './windows-busy'

describe('isConsoleHelper', () => {
  it('recognizes Windows console host helpers regardless of case, path or extension', () => {
    for (const name of [
      'conhost.exe',
      'CONHOST.EXE',
      'C:\\Windows\\System32\\conhost.exe',
      'OpenConsole.exe',
      'openconsole',
      'winpty-agent.exe',
      'C:\\app\\winpty-agent.exe',
      'conpty_console_list_agent.exe',
      'C:\\app\\node_modules\\node-pty\\conpty_console_list_agent.exe',
    ]) {
      expect(isConsoleHelper(name)).toBe(true)
    }
  })

  it('does not treat shells or user commands as console helpers', () => {
    for (const name of ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'node.exe', 'git.exe', '']) {
      expect(isConsoleHelper(name)).toBe(false)
    }
  })
})

describe('parseWindowsProcesses', () => {
  it('parses tab-separated process snapshot lines with CRLF or LF line endings', () => {
    const output = [
      '0\t0\tSystem Idle Process',
      '100\t4\tpwsh.exe',
      '200\t100\tconhost.exe',
      '300\t100\tnode.exe',
      '',
    ].join('\r\n')
    expect(parseWindowsProcesses(output)).toEqual([
      { pid: 0, parentPid: 0, name: 'System Idle Process' },
      { pid: 100, parentPid: 4, name: 'pwsh.exe' },
      { pid: 200, parentPid: 100, name: 'conhost.exe' },
      { pid: 300, parentPid: 100, name: 'node.exe' },
    ])
  })

  it('returns null when output is empty or contains no valid process entries', () => {
    expect(parseWindowsProcesses('')).toBeNull()
    expect(parseWindowsProcesses('   \r\n\t\n')).toBeNull()
    expect(parseWindowsProcesses('Get-CimInstance : Access denied\r\n')).toBeNull()
  })
})

describe('hasRunningChildProcess', () => {
  it('returns false for an idle shell with no child processes', () => {
    const processes: WindowsProcess[] = [
      { pid: 50, parentPid: 1, name: 'Kettu.exe' },
      { pid: 100, parentPid: 50, name: 'pwsh.exe' },
      { pid: 200, parentPid: 50, name: 'node.exe' },
    ]
    expect(hasRunningChildProcess(100, processes)).toBe(false)
  })

  it('returns false for an idle shell that only has console helper children', () => {
    const processes: WindowsProcess[] = [
      { pid: 100, parentPid: 50, name: 'pwsh.exe' },
      { pid: 101, parentPid: 100, name: 'conhost.exe' },
      { pid: 102, parentPid: 100, name: 'OpenConsole.exe' },
      { pid: 103, parentPid: 101, name: 'winpty-agent.exe' },
      { pid: 104, parentPid: 100, name: 'conpty_console_list_agent.exe' },
    ]
    expect(hasRunningChildProcess(100, processes)).toBe(false)
  })

  it('returns false for idle PowerShell and cmd prompts after a previous command has exited', () => {
    const idleAfterCommand: WindowsProcess[] = [
      { pid: 50, parentPid: 1, name: 'Kettu.exe' },
      { pid: 100, parentPid: 50, name: 'powershell.exe' },
      { pid: 101, parentPid: 100, name: 'conhost.exe' },
      { pid: 200, parentPid: 50, name: 'cmd.exe' },
      { pid: 201, parentPid: 200, name: 'conhost.exe' },
    ]
    expect(hasRunningChildProcess(100, idleAfterCommand)).toBe(false)
    expect(hasRunningChildProcess(200, idleAfterCommand)).toBe(false)
  })

  it('returns true when the shell runs a child command directly or beneath a console helper', () => {
    const direct: WindowsProcess[] = [
      { pid: 100, parentPid: 50, name: 'pwsh.exe' },
      { pid: 101, parentPid: 100, name: 'conhost.exe' },
      { pid: 200, parentPid: 100, name: 'node.exe' },
    ]
    expect(hasRunningChildProcess(100, direct)).toBe(true)

    const nested: WindowsProcess[] = [
      { pid: 100, parentPid: 50, name: 'powershell.exe' },
      { pid: 101, parentPid: 100, name: 'conhost.exe' },
      { pid: 200, parentPid: 101, name: 'git.exe' },
    ]
    expect(hasRunningChildProcess(100, nested)).toBe(true)
  })

  it('terminates safely on invalid PIDs and cyclic parent relationships from PID reuse', () => {
    const cyclic: WindowsProcess[] = [
      { pid: 100, parentPid: 101, name: 'pwsh.exe' },
      { pid: 101, parentPid: 100, name: 'conhost.exe' },
      { pid: 102, parentPid: 102, name: 'conhost.exe' },
    ]
    expect(hasRunningChildProcess(100, cyclic)).toBe(false)
    expect(hasRunningChildProcess(0, cyclic)).toBe(false)
    expect(hasRunningChildProcess(-1, cyclic)).toBe(false)
  })
})
