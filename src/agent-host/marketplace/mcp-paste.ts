import { splitCommand } from '@shared/mcp-command'
import { MARKET_NAME, serverName } from '@shared/marketplace'
import { configuredMcp, object, type ConfiguredMcp } from './mcp-config'

function invalid(): never {
  throw new Error('Enter a URL, a command, or an MCP configuration.')
}

function pair(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator)
  if (at <= 0) return invalid()
  return [text.slice(0, at).trim(), text.slice(at + 1).trimStart()]
}

function cli(words: string[]): { name: string; config: Record<string, unknown> } {
  const [program, , , ...args] = words
  const codex = program === 'codex'
  const options = Object.create(null) as Record<string, string>
  const env = Object.create(null) as Record<string, string>
  const headers = Object.create(null) as Record<string, string>
  const positional: string[] = []
  let separator: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      separator = positional.length
      positional.push(...args.slice(i + 1))
      break
    }
    const transport = options['--transport'] ?? options['-t']
    const remote = transport === 'http' || transport === 'sse' || options['--url'] !== undefined
    if (!arg.startsWith('-') || (!codex && !remote && positional.length > 1)) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const flag = eq < 0 ? arg : arg.slice(0, eq)
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1)
    if (value === undefined) return invalid()
    switch (flag) {
      case '-e':
      case '--env': {
        const [name, text] = pair(value, '=')
        env[name] = text
        break
      }
      case '-H':
      case '--header': {
        const [name, text] = pair(value, ':')
        headers[name] = text
        break
      }
      case '-t':
      case '--transport':
      case '--url':
      case '--bearer-token-env-var':
        options[flag] = value
        break
      case '-s':
      case '--scope':
        break
      default:
        return invalid()
    }
  }
  const [name, target, ...serverArgs] = positional
  if (!name || (codex && separator !== undefined && separator !== 1)) return invalid()
  const type = options['--transport'] ?? options['-t']
  const url = options['--url'] ?? (type === 'http' || type === 'sse' ? target : undefined)
  if (url !== undefined) {
    return {
      name,
      config: { url, type, headers, bearer_token_env_var: options['--bearer-token-env-var'] },
    }
  }
  if (!target) return invalid()
  return { name, config: { command: target, args: serverArgs, env } }
}

export function parseMcpPaste(input: string): ConfiguredMcp[] {
  const text = input.trim()
  if (!text) return invalid()
  const source = { path: '' }
  if (text.startsWith('{')) {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return invalid()
    }
    const servers = object(object(raw)?.mcpServers)
    if (!servers || Object.keys(servers).length === 0 || Object.keys(servers).length > 100)
      return invalid()
    return Object.entries(servers).map(
      ([name, config]) => configuredMcp(name, config, source) ?? invalid(),
    )
  }
  if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return invalid()
    }
    return [
      configuredMcp(serverName(url.hostname.split('.')[0] ?? '', []), { url: text }, source) ??
        invalid(),
    ]
  }
  const words = splitCommand(text)
  if (!words?.length) return invalid()
  const [command, action, target, ...rest] = words
  if ((command === 'claude' || command === 'codex') && action === 'mcp' && target === 'add') {
    const { name, config } = cli(words)
    return [configuredMcp(name, config, source) ?? invalid()]
  }
  const base = command!.split(/[\\/]/).pop() ?? 'server'
  const pkg =
    command === 'npx' && (action === '-y' || action === '--yes')
      ? target?.split('/').pop()?.split('@')[0]
      : undefined
  const name = pkg || base.replace(/\.(?:exe|cmd|bat)$/i, '')
  const args = [action, target, ...rest].filter((word): word is string => word !== undefined)
  return [
    configuredMcp(
      MARKET_NAME.test(name) ? name : serverName(name, []),
      { command, args },
      source,
    ) ?? invalid(),
  ]
}
