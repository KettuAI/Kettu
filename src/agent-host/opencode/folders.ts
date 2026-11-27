// OpenCode runs a folder's own config, plugins and MCP servers as soon as a request names the
// folder, so its sessions run on a server started with the project config turned off, and only
// the sessions of folders whose own settings the user let apply run on a second server started
// without it.

import type { HostedContext } from '../driver'
import { FolderConnections } from '../folder-connections'
import { OpenCodeConnection } from './connection'
import { startServer, type StartServer } from './server'

/** Turns OpenCode's project config off, as its own flag does for every folder of a server. */
export const HELD_ENV = { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } as const

export class OpenCodeFolders extends FolderConnections<OpenCodeConnection> {
  constructor(context: HostedContext, start: StartServer = startServer) {
    super({
      make: (held) =>
        new OpenCodeConnection(
          held ? { ...context, env: { ...context.env, ...HELD_ENV } } : context,
          start,
        ),
      has: (connection, sessionId) => connection.has(sessionId),
    })
  }

  /** OpenCode's stored sessions, which both servers read alike. */
  get stored(): OpenCodeConnection['stored'] {
    return this.held.stored
  }
}
