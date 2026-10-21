import { describe, expect, it } from 'vitest'
import { formatCommand, quoteCmd, quotePosix } from './quote'

describe('quotePosix', () => {
  it('leaves safe words alone', () => {
    expect(quotePosix('npx')).toBe('npx')
    expect(quotePosix('@agentclientprotocol/claude-agent-acp@0.94.0')).toBe(
      '@agentclientprotocol/claude-agent-acp@0.94.0',
    )
    expect(quotePosix('--rate=5')).toBe('--rate=5')
  })

  it('single-quotes everything else, escaping single quotes', () => {
    expect(quotePosix('')).toBe("''")
    expect(quotePosix('/Applications/My App/bin')).toBe("'/Applications/My App/bin'")
    expect(quotePosix("it's")).toBe("'it'\\''s'")
    expect(quotePosix('$HOME')).toBe("'$HOME'")
    expect(quotePosix('=cmd')).toBe("'=cmd'")
    expect(quotePosix('a*b')).toBe("'a*b'")
    expect(quotePosix('~/x')).toBe("'~/x'")
  })
})

describe('quoteCmd', () => {
  it('leaves safe words alone', () => {
    expect(quoteCmd('npx')).toBe('npx')
    expect(quoteCmd('C:\\Tools\\opencode.exe')).toBe('C:\\Tools\\opencode.exe')
  })

  it('double-quotes words with spaces or cmd metacharacters', () => {
    expect(quoteCmd('C:\\Program Files\\nodejs\\npx.cmd')).toBe(
      '"C:\\Program Files\\nodejs\\npx.cmd"',
    )
    expect(quoteCmd('a&b')).toBe('"a&b"')
    expect(quoteCmd('50%')).toBe('"50%"')
    expect(quoteCmd('say "hi"')).toBe('"say ""hi"""')
    expect(quoteCmd('')).toBe('""')
  })
})

describe('formatCommand', () => {
  const line = {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0', '--cli', 'auth', 'login'],
  }

  it('joins words for each platform', () => {
    expect(formatCommand(line, 'darwin')).toBe(
      'npx -y @agentclientprotocol/claude-agent-acp@0.94.0 --cli auth login',
    )
    expect(formatCommand(line, 'win32')).toBe(
      'npx -y @agentclientprotocol/claude-agent-acp@0.94.0 --cli auth login',
    )
  })

  it('prefixes environment variables in each shell syntax', () => {
    const withEnv = {
      command: '/Apps/Electron App/Electron',
      args: ['/repo/tools/fake-agent/main.ts', '--login'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
    expect(formatCommand(withEnv, 'linux')).toBe(
      "ELECTRON_RUN_AS_NODE=1 '/Apps/Electron App/Electron' /repo/tools/fake-agent/main.ts --login",
    )
    expect(formatCommand({ ...withEnv, command: 'C:\\Electron App\\electron.exe' }, 'win32')).toBe(
      'set "ELECTRON_RUN_AS_NODE=1" && "C:\\Electron App\\electron.exe" /repo/tools/fake-agent/main.ts --login',
    )
  })
})
