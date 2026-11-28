import { parseJsonVersion } from '../agent-updates'
import type { AgentDefinition } from '../catalog'
import { AGY_CLI } from '../installed-cli'

// The user's own Antigravity CLI in its ACP mode, checked on agy 1.5.9. It runs every command in
// the folder it started in, whatever folder a session names, so each session gets a process of its
// own started in its folder. Full access starts a session's process with agy's own flag.
export const ANTIGRAVITY: AgentDefinition = {
  id: 'antigravity',
  limitsReason: 'vendor-disallows',
  name: 'Google Antigravity',
  registryId: 'antigravity-acp',
  launch: {
    kind: 'binary',
    command: 'agy',
    args: ['acp'],
    perSession: true,
    sessionFlag: '--dangerously-skip-permissions',
    sessionArgs: ['--app-data-dir'],
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
    scriptHomeWin: ['AppData', 'Local', 'agy', 'bin'],
    selfUpdate: ['update'],
    // The same release manifest the official install.sh and install.ps1 read.
    versionCheck: {
      urls: (platform, arch) => {
        const osName = platform === 'win32' ? 'windows' : platform
        const machine = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null
        if (!machine || (osName !== 'darwin' && osName !== 'linux' && osName !== 'windows')) {
          return []
        }
        return [
          `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${osName}_${machine}.json`,
        ]
      },
      parse: (body) => parseJsonVersion(body, ['version']),
    },
    order: ['script'],
  },
  cli: AGY_CLI,
  // agy 1.5.17 has no variable that moves `~/.gemini`; `agy acp` takes it with this flag.
  configFlag: { flag: '--gemini-dir', under: '.gemini' },
  // agy keeps its Google sign-in in one keychain entry per computer whatever the folder, so a
  // second sign-in would replace the first; this keeps it in a file in the agent's own folder.
  addedEnv: { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1' },
  sharesSignIn: true,
  // `authenticate` with this method switches agy to the key in its environment; the key alone
  // does not (agy 1.5.9).
  keySignIn: { method: 'gemini-api-key', variable: 'GEMINI_API_KEY' },
  // Google and Gemini Enterprise sign in through agy's own terminal sign-in.
  terminalSignIn: { replaces: ['oauth-personal', 'oauth-business'] },
  // agy 1.5.14 drops the largest MCP tools past its customization budget, and over ACP gives the
  // model no call_mcp_tool for a dropped one.
  toolGateway: true,
  // 启用本地精确上下文构成读取，并在新会话首轮前保留 Skills 与 MCP 工具定义估算区。
  readsContext: true,
  contextEstimates: true,
}
