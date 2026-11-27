// Pure path safety, action planning, and display helpers for configuration warning notices.

import type { ConfigWarningSource } from '@shared/thread'
import { isLocalProject, relativeToRoot } from '@renderer/features/files/file-location'

/** Official Codex configuration reference documentation. */
export const CODEX_CONFIG_DOCS_URL = 'https://developers.openai.com/codex/config-reference'

/** Returns `url` when it is an http(s) URL, otherwise falls back to the official Codex docs URL. */
export function safeConfigDocsUrl(url: string | undefined): string {
  if (!url) return CODEX_CONFIG_DOCS_URL
  const parsed = URL.parse(url)
  return parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    ? url
    : CODEX_CONFIG_DOCS_URL
}

const MAX_LOCAL_PATH_CHARS = 4_096
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i

export interface ConfigWarningActionContext {
  /** Active session project path, or empty string when unknown. */
  projectPath: string
  /** Whether the UI runs in the web client rather than the desktop app. */
  web: boolean
}

export interface ConfigWarningSourceAction {
  /** Path formatted with optional 1-based `:line` / `:line:column` suffix. */
  location: string
  /** Target inside Kettu's Files side pane when the file lives inside the current project. */
  filesPane: { projectPath: string; relativePath: string; line: number | null } | null
  /** Valid local absolute path that may open in the system's default app, else null. */
  localFile: string | null
  /** Primary one-click open action, or null when the client should gracefully degrade. */
  primary: 'files-pane' | 'default-app' | null
}

/**
 * Whether `filePath` is a valid local absolute path suitable for `shell.openFile`.
 * Rejects relative paths, unexpanded `~` paths, NUL bytes, and UNC/network share paths.
 */
export function isSafeLocalConfigPath(filePath: string): boolean {
  if (!filePath || filePath.length > MAX_LOCAL_PATH_CHARS || filePath.includes('\0')) return false
  if (filePath.startsWith('~')) return false
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) return false
  return filePath.startsWith('/') || WINDOWS_DRIVE_PATH.test(filePath)
}

/** Formats a config source path with its optional 1-based line and column. */
export function formatConfigWarningLocation(source: ConfigWarningSource): string {
  if (source.line !== undefined && source.column !== undefined) {
    return `${source.path}:${source.line}:${source.column}`
  }
  if (source.line !== undefined) {
    return `${source.path}:${source.line}`
  }
  return source.path
}

const KNOWN_LAYERS = new Set(['user', 'project', 'system', 'profile', 'managed', 'mdm'] as const)
export type KnownConfigWarningLayer = 'user' | 'project' | 'system' | 'profile' | 'managed' | 'mdm'

/** Returns a known i18n layer key when Codex reported a recognized layer name, else null. */
export function knownConfigWarningLayer(layer: string | undefined): KnownConfigWarningLayer | null {
  if (!layer) return null
  const normalized = layer.trim().toLowerCase()
  return KNOWN_LAYERS.has(normalized as KnownConfigWarningLayer)
    ? (normalized as KnownConfigWarningLayer)
    : null
}

/**
 * Plans which file-open capabilities a configuration warning source can offer:
 * - Files inside the current project open in Kettu's Files side pane (desktop, remote, and web).
 * - Local files outside the project (e.g. `~/.codex/config.toml`) open in the default app only
 *   on a local desktop session with a valid local absolute path.
 * - Remote or web sessions with files outside the project gracefully degrade to read-only display.
 */
export function resolveConfigWarningSourceAction(
  source: ConfigWarningSource,
  context: ConfigWarningActionContext,
): ConfigWarningSourceAction {
  const location = formatConfigWarningLocation(source)
  const relativePath = context.projectPath ? relativeToRoot(source.path, context.projectPath) : null
  const filesPane =
    relativePath !== null
      ? {
          projectPath: context.projectPath,
          relativePath,
          line: source.line ?? null,
        }
      : null
  const localFile =
    context.projectPath !== '' &&
    isLocalProject(context.projectPath, context.web) &&
    isSafeLocalConfigPath(source.path)
      ? source.path
      : null
  const primary = filesPane !== null ? 'files-pane' : localFile !== null ? 'default-app' : null
  return { location, filesPane, localFile, primary }
}
