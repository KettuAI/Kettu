// The terminal host's process, whatever runs it: main's messages in over the control channel, the
// host's out, and each client's port as it connects. index.ts runs it in Electron's utility
// process, node-main.ts under Node.js.

import type { MainToTerminalHost, TerminalHostToMain } from '@shared/host-control'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import type { TerminalEvent } from '@shared/terminal-host'
import { ProjectRegistry } from './projects'
import { PortServer } from './server'
import { type PtyProcess, type PtySpawn, TerminalManager } from './terminals'

export interface StartedTerminalHost {
  /** A client's port, from the window `windowId` names; closed if the host has not started. */
  connect(port: PortChannel<FromPort<TerminalEvent>>, windowId: number): void
}

function warn(message: string): void {
  console.warn(message)
}

async function loadPty(): Promise<PtySpawn> {
  const pty = await import('node-pty')
  return (file, args, options) => pty.spawn(file, args, options)
}

// node-pty lists a ConPTY's attached processes for its own kill(); it is not public API, so a
// missing method means "unknown" rather than "idle".
type WindowsPty = { _agent?: { _getConsoleProcessList?: () => Promise<number[]> } }

function consoleProcesses(pty: PtyProcess): Promise<number[] | null> {
  const agent = (pty as unknown as WindowsPty)._agent
  if (typeof agent?._getConsoleProcessList !== 'function') return Promise.resolve(null)
  return agent._getConsoleProcessList().catch(() => null)
}

export function startTerminalHost(
  control: ControlChannel<MainToTerminalHost, TerminalHostToMain>,
): StartedTerminalHost {
  const send = (message: TerminalHostToMain): void => control.send(message)
  let manager: TerminalManager | null = null
  let server: PortServer | null = null
  let projects: ProjectRegistry | null = null

  function init(message: Extract<MainToTerminalHost, { type: 'terminal-host:init' }>): void {
    projects = new ProjectRegistry(message.platform)
    projects.set(message.projects)
    const terminals = new TerminalManager({
      platform: message.platform,
      appVersion: message.appVersion,
      env: process.env,
      projects,
      loadPty,
      consoleProcesses,
      warn,
      sink: {
        data: (id, data, ports) => {
          for (const port of ports) server?.send(port, { type: 'terminal.data', id, data })
        },
        info: (info) => server?.broadcast({ type: 'terminal.info', info }),
        removed: (id) => server?.broadcast({ type: 'terminal.removed', id }),
      },
    })
    terminals.setShellPath(message.settings.shellPath)
    terminals.setAuthCommands(message.authCommands)
    manager = terminals
    server = new PortServer(
      {
        'terminals.create': (port, params) => terminals.create(port, params),
        'terminals.list': (_, params) => terminals.list(params.projectPath),
        'terminals.attach': (port, params) => terminals.attach(port, params.id),
        'terminals.input': (_, params) => terminals.input(params.id, params.data),
        'terminals.resize': (_, params) => terminals.resize(params.id, params.cols, params.rows),
        'terminals.ack': (port, params) => terminals.ack(port, params.id, params.chars),
        'terminals.kill': (_, params) => terminals.kill(params.id),
        'terminals.restart': (_, params) => terminals.restart(params.id),
      },
      (port) => terminals.detach(port),
      warn,
    )
    send({ type: 'terminal-host:ready' })
    // The host starts with the first terminal anyway, so loading node-pty now costs nothing and
    // reports a broken native module before anyone types.
    void terminals.warmUp().then((error) => {
      if (error) console.error(error)
      else console.log('node-pty loaded')
    })
  }

  control.onMessage((message) => {
    switch (message?.type) {
      case 'terminal-host:init':
        if (!manager) init(message)
        break
      case 'terminal-host:settings':
        manager?.setShellPath(message.settings.shellPath)
        break
      case 'terminal-host:projects':
        projects?.set(message.paths)
        break
      case 'terminal-host:auth-commands':
        manager?.setAuthCommands(message.commands)
        break
      case 'terminal-host:busy-request':
        void (manager?.busy() ?? Promise.resolve([])).then((terminals) =>
          send({ type: 'terminal-host:busy', requestId: message.requestId, terminals }),
        )
        break
      case 'terminal-host:shutdown':
        manager?.dispose()
        server?.closeAll()
        send({ type: 'terminal-host:stopped' })
        process.exit(0)
    }
  })

  return {
    connect: (port, windowId) => {
      if (server) server.attach(port, windowId)
      else port.close()
    },
  }
}
