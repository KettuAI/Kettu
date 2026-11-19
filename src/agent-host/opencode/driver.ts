// OpenCode's driver for its own server: it runs in the agent host, which starts one
// `opencode serve` for all of the agent's sessions.

import type { HostedDriver } from '../driver'
import { OpenCodeConnection } from './connection'

export const OPENCODE_SERVER_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) => new OpenCodeConnection(context),
}
