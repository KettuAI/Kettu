import type { AgentDefinition } from '../catalog'
import { AGY_CLI } from '../installed-cli'

// The user's own Antigravity CLI in its ACP mode, checked on agy 1.5.9. It runs every command in
// the folder it started in, whatever folder a session names, so each session gets a process of its
// own started in its folder. Full access starts a session's process with agy's own flag.
export const ANTIGRAVITY: AgentDefinition = {
  id: 'antigravity',
  name: 'Google Antigravity',
  registryId: 'antigravity-acp',
  launch: {
    kind: 'binary',
    command: 'agy',
    args: ['acp'],
    perSession: true,
    sessionFlag: '--dangerously-skip-permissions',
  },
  install: {
    hint: 'detect.hint.antigravity',
    url: 'https://antigravity.google/docs/cli/acp',
    notice: 'detect.antigravityInstallNotice',
  },
  installs: {
    script: 'https://antigravity.google/cli/install.sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    selfUpdate: ['update'],
    order: ['script'],
  },
  cli: AGY_CLI,
  sharesSignIn: true,
  // `authenticate` with this method switches agy to the key in its environment; the key alone
  // does not (agy 1.5.9).
  keySignIn: { method: 'gemini-api-key', variable: 'GEMINI_API_KEY' },
  // Google and Gemini Enterprise sign in through agy's own terminal sign-in.
  terminalSignIn: { replaces: ['oauth-personal', 'oauth-business'] },
  // agy 1.5.14 drops the largest MCP tools past its customization budget, and over ACP gives the
  // model no call_mcp_tool for a dropped one.
  toolGateway: true,
  // 启用上下文弹窗中的 Skills 与 MCP 工具定义估算区。
  contextEstimates: true,
}
