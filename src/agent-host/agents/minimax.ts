import type { AgentDefinition } from '../catalog'

export const MINIMAX: AgentDefinition = {
  id: 'minimax',
  name: 'MiniMax Code',
  registryId: 'minimax-code',
  // Every version needs better-sqlite3's binding, built only by its install script, so Kettu runs
  // the user's own `mcode` instead of a script-free install of its own.
  launch: { kind: 'binary', command: 'mcode', args: ['acp'] },
  install: { hint: 'detect.hint.minimax', url: 'https://agent.minimax.io' },
  // The command its README lists, checked on 2026-11-15.
  installs: { npm: '@minimax-ai/code' },
}
