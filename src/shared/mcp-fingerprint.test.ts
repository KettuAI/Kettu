import { describe, expect, it } from 'vitest'
import { mcpFingerprint } from './mcp-fingerprint'

const http = (url: string): string => mcpFingerprint({ type: 'http', url })
const npx = (...args: string[]): string => mcpFingerprint({ type: 'stdio', command: 'npx', args })

describe('mcpFingerprint', () => {
  it('compares normalized URLs regardless of transport', () => {
    expect(http('HTTPS://EXAMPLE.COM:443/mcp/#section')).toBe(
      mcpFingerprint({ type: 'sse', url: 'https://example.com/mcp' }),
    )
    expect(http('https://example.com/mcp?workspace=A')).not.toBe(
      http('https://example.com/mcp?workspace=B'),
    )
    expect(http('https://example.com/MCP')).not.toBe(http('https://example.com/mcp'))
  })

  it('normalizes the package version and keeps its arguments', () => {
    expect(npx('-y', '@scope/server@1.0.0', './work')).toBe(
      npx('--yes', '@scope/server@latest', './work'),
    )
    expect(npx('-y', 'server@1.0.0')).toBe(npx('-y', 'server'))
    expect(npx('-y', 'server@1.0.0', 'a')).not.toBe(npx('-y', 'server', 'b'))
    expect(npx('-y', './server@1.0.0')).not.toBe(npx('-y', './server@2.0.0'))
  })

  it('compares other commands and ordered argument boundaries', () => {
    const run = (command: string, ...args: string[]): string =>
      mcpFingerprint({ type: 'stdio', command, args })
    expect(run('uvx', 'server', 'a b')).not.toBe(run('uvx', 'server', 'a', 'b'))
    expect(run('uvx', 'server', 'a', 'b')).not.toBe(run('uvx', 'server', 'b', 'a'))
    expect(run('/usr/bin/uvx', 'server')).not.toBe(run('uvx', 'server'))
  })
})
