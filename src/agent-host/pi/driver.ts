// Pi's driver: its RPC mode, run in the agent host, which spawns one `pi --mode rpc` per open
// session.

import type { HostedDriver } from '../driver'
import { PiConnection } from './connection'

export const PI_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) => new PiConnection(context),
}
