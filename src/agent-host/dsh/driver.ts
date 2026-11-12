// DeepSeek Harness's driver: its SDK interface, run in the agent host, which spawns one
// `dsh --profile sdk` per open session.

import type { HostedDriver } from '../driver'
import { DshConnection } from './connection'

export const DSH_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) => new DshConnection(context),
}
