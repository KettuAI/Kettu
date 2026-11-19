import type { AgentDefinition } from '../catalog'
import type { AdapterCli } from '../installed-cli'

// Pi runs as found, a `.cmd` shim on Windows included: npm installs it as a script, which Kettu
// starts through the shell as it does any other.
const PI_CLI: AdapterCli = {
  command: 'pi',
  pinsVersion: false,
  // The oldest pi whose RPC mode was checked: it settles its runs, lists a session's entries and
  // names the thinking levels its model takes.
  oldest: '0.81.0',
  resolve: async (found) => ({ path: found, env: {} }),
}

// Only the user's own `pi` runs, in its RPC mode, with a process for each open session; Kettu
// installs nothing beside it.
export const PI: AgentDefinition = {
  id: 'pi',
  limitsReason: 'model-provider-managed',
  name: 'Pi',
  registryId: 'pi-acp',
  protocol: 'pi-rpc',
  launch: { kind: 'binary', command: 'pi', args: ['--mode', 'rpc'] },
  install: {
    hint: 'detect.hint.pi',
    url: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md',
  },
  // The npm command the quickstart lists, checked on 2026-11-03. Its installer script asks
  // questions on a terminal, so it is not a route.
  installs: { npm: '@earendil-works/pi-coding-agent', ignoreScripts: true },
  cli: PI_CLI,
}
