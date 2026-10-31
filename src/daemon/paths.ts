import path from 'node:path'

/** Names a data folder in place of the default, for tests and development. */
export const DATA_ENV = 'KETTU_DAEMON_DATA'

export interface DataPathInput {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  /** Where a relative override is resolved from. */
  cwd: string
}

/**
 * The daemon's data folder. It is not the desktop app's, so an app on the same computer stays a
 * host of its own, with its own identity and sessions.
 */
export function dataPath({ platform, home, env, cwd }: DataPathInput): string {
  const override = env[DATA_ENV]?.trim()
  if (override) return path.resolve(cwd, override)
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Kettu Daemon')
  }
  // The XDG base directory spec ignores a relative path.
  const xdg = env.XDG_DATA_HOME?.trim()
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share'), 'kettu')
}

// sun_path holds 104 bytes on macOS and 108 on Linux, its terminating NUL included.
const MAX_SOCKET_PATH = 103

/** The socket the CLI reaches the running daemon on, or null when the folder's path is too long. */
export function controlSocketPath(data: string): string | null {
  const socket = path.join(data, 'control.sock')
  return Buffer.byteLength(socket) <= MAX_SOCKET_PATH ? socket : null
}

/** The host's identity with its private key, where the desktop app keeps its own. */
export function keyPath(data: string): string {
  return path.join(data, 'remote', 'identity.json')
}

/** Where the macOS service writes the daemon's output, which launchd sends to a file. */
export function logPath(data: string): string {
  return path.join(data, 'logs', 'daemon.log')
}
