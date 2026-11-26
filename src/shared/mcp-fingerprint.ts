export type McpEndpoint =
  | { type: 'http' | 'sse'; url: string }
  | { type: 'stdio'; command: string; args: readonly string[] }

const NPX_PACKAGE = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@[^/\\\s]+)?$/i

/**
 * Compares a library spec or session endpoint by where it connects or what it starts.
 * The key may contain the URL or arguments. Keep it out of logs and client responses.
 */
export function mcpFingerprint(endpoint: McpEndpoint): string {
  if (endpoint.type !== 'stdio') {
    const text = endpoint.url.trim()
    try {
      const url = new URL(text)
      url.hash = ''
      url.pathname = url.pathname.replace(/\/$/, '')
      return JSON.stringify(['remote', url.href])
    } catch {
      return JSON.stringify(['remote', text])
    }
  }

  const { command, args } = endpoint
  if (command === 'npx' && (args[0] === '-y' || args[0] === '--yes')) {
    const pkg = args[1]?.match(NPX_PACKAGE)?.[1]
    if (pkg) return JSON.stringify(['npx', pkg, ...args.slice(2)])
  }
  return JSON.stringify(['stdio', command, ...args])
}
