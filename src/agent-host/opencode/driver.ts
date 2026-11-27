// OpenCode's driver for its own server: it runs in the agent host, which starts one
// `opencode serve` for the agent's sessions, and a second for those in folders whose own settings
// the user let apply.

import type { HostedDriver } from '../driver'
import { OpenCodeFolders } from './folders'

export const OPENCODE_SERVER_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) => new OpenCodeFolders(context),
}
