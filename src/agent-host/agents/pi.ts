import type { AgentDefinition } from '../catalog'

export const PI: AgentDefinition = {
  id: 'pi',
  name: 'Pi',
  registryId: 'pi-acp',
  // pi-acp keeps one live session per process, so every session gets an adapter process of its own.
  launch: { kind: 'package', package: 'pi-acp', version: '0.0.34', perSession: true },
  requiresNode: '>=22',
  requires: { command: 'pi', minimum: '0.81.0', variable: 'PI_ACP_PI_COMMAND' },
  // pi-acp 0.0.34 advertises embedded context only with this set, so attached files keep their text.
  env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' },
  // pi-acp 0.0.34's one auth method just runs `pi`, so the sign-in command is `pi` alone.
  signInWithCli: true,
  // pi-acp 0.0.34 sends its thought levels again as legacy modes.
  levelsAsModes: true,
  // pi-acp 0.0.34 sends pi's startup note as the session's first agent message.
  startupNote: true,
  install: {
    hint: 'detect.hint.pi',
    url: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md',
  },
}
