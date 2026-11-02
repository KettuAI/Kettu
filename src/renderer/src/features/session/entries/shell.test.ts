import { describe, expect, it } from 'vitest'
import { ansiRuns, exitOf, SHELL_TAIL, shellTail } from './shell'

describe('shellTail', () => {
  const output = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}`).join('\n')

  it('shows a short output whole', () => {
    expect(shellTail(output(12), false)).toEqual({ shown: output(12), earlier: 0 })
  })

  it('shows the last lines of a long one and counts the rest', () => {
    const { shown, earlier } = shellTail(output(155) + '\n', false)
    expect(shown.split('\n')).toHaveLength(SHELL_TAIL)
    expect(shown.endsWith('155')).toBe(true)
    expect(earlier).toBe(155 - SHELL_TAIL)
  })

  it('shows everything once opened', () => {
    expect(shellTail(output(30), true).earlier).toBe(0)
  })
})

describe('exitOf', () => {
  it('reads the code a failed command states, and drops that line', () => {
    expect(exitOf('Exit code 1\nExpected: 7', 'failed', 'claude-code')).toEqual({
      code: 1,
      output: 'Expected: 7',
    })
  })

  it('knows a completed command exited 0 under Claude Code and Codex', () => {
    expect(exitOf('ok', 'completed', 'claude-code').code).toBe(0)
    expect(exitOf(null, 'completed', 'codex').code).toBe(0)
  })

  it('claims no code where the agent does not say', () => {
    expect(exitOf('ok', 'completed', 'opencode').code).toBeNull()
    expect(exitOf('boom', 'failed', 'claude-code').code).toBeNull()
    expect(exitOf(null, 'in_progress', 'codex').code).toBeNull()
  })
})

describe('ansiRuns', () => {
  it('keeps red, green and dim and drops the escapes', () => {
    expect(ansiRuns('\x1b[32m✓\x1b[39m a \x1b[2m(6 tests)\x1b[22m')).toEqual([
      { text: '✓', tone: 'green' },
      { text: ' a ', tone: null },
      { text: '(6 tests)', tone: 'dim' },
    ])
  })

  it('drops the colors it does not keep, cursor moves and titles', () => {
    expect(ansiRuns('\x1b[34mblue\x1b[0m\x1b[2K\x1b]0;title\x07 done')).toEqual([
      { text: 'blue done', tone: null },
    ])
  })

  it('reads bright colors and combined codes', () => {
    expect(ansiRuns('\x1b[1;91mFAIL\x1b[0m')).toEqual([{ text: 'FAIL', tone: 'red' }])
  })

  it('leaves plain text alone', () => {
    expect(ansiRuns('plain')).toEqual([{ text: 'plain', tone: null }])
    expect(ansiRuns('')).toEqual([])
  })
})
