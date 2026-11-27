import { afterEach, describe, expect, it } from 'vitest'
import { isDiskFullError, isDiskFullText } from './disk-full'
import { extractStderrSummary, formatExitReason, stripAnsi } from './exit-reason'
import { setLocale } from './i18n'
import { ThreadStoreError } from './threads/store'

afterEach(() => {
  setLocale('en')
})

describe('disk-full detection', () => {
  it('recognizes ENOSPC, EDQUOT, SQLITE_FULL, ThreadStoreError full, and localized messages', () => {
    const enospc = Object.assign(new Error('write failed'), { code: 'ENOSPC' })
    const edquot = Object.assign(new Error('quota exceeded'), { code: 'EDQUOT' })
    const sqliteFull = Object.assign(new Error('sqlite failed'), { errcode: 13 })
    const wrapped = new Error('outer failure', { cause: enospc })
    const threadFull = new ThreadStoreError('database or disk is full', 'full')

    expect(isDiskFullError(enospc)).toBe(true)
    expect(isDiskFullError(edquot)).toBe(true)
    expect(isDiskFullError(sqliteFull)).toBe(true)
    expect(isDiskFullError(wrapped)).toBe(true)
    expect(isDiskFullError(threadFull)).toBe(true)
    expect(isDiskFullError(new Error('ENOSPC: no space left on device, write'))).toBe(true)
    expect(isDiskFullText('There is not enough space on the disk.')).toBe(true)

    expect(isDiskFullError(Object.assign(new Error('not found'), { code: 'ENOENT' }))).toBe(false)
    expect(isDiskFullError(new Error('network timeout'))).toBe(false)
    expect(isDiskFullError(null)).toBe(false)
  })
})

describe('extractStderrSummary', () => {
  it('strips ANSI escapes, filters stack frames and deprecation warnings, and redacts secrets', () => {
    const stderr = [
      '(node:1234) ExperimentalWarning: SQLite is an experimental feature',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      '2026-11-27T10:00:00Z [INFO] starting worker',
      '\x1b[31mError: authentication failed with key sk-1234567890abcdefghijklmnop\x1b[0m',
      '    at Client.send (/app/client.js:42:11)',
      '    at async main (/app/index.js:10:5)',
      'Node.js v22.12.0',
    ].join('\n')

    const result = extractStderrSummary(stderr)
    expect(result).not.toBeNull()
    expect(result?.diskFull).toBe(false)
    expect(result?.summary).toContain('Error: authentication failed with key <redacted>')
    expect(result?.summary).not.toContain('sk-1234567890')
    expect(result?.summary).not.toContain('at Client.send')
    expect(result?.summary).not.toContain('ExperimentalWarning')
    expect(result?.summary).not.toContain('\x1b[')
  })

  it('prioritizes disk-full errors over other stderr lines and marks diskFull', () => {
    const stderr = [
      'Error: write failed',
      'fs.writeFileSync: ENOSPC: no space left on device, write',
      '    at Object.writeFileSync (node:fs:2345:20)',
      'Node.js v22.12.0',
    ].join('\n')

    const result = extractStderrSummary(stderr)
    expect(result).toEqual({
      summary: 'fs.writeFileSync: ENOSPC: no space left on device, write',
      diskFull: true,
    })
  })

  it('returns null for pure boilerplate noise or info logs', () => {
    const stderr = [
      '(node:99) DeprecationWarning: old API',
      '2026-11-27T10:00:00Z [DEBUG] heartbeat ok',
      '   at Object.<anonymous> (/tmp/a.js:1:1)',
      '-----',
    ].join('\n')

    expect(extractStderrSummary(stderr)).toBeNull()
    expect(stripAnsi('\x1b[1;32mok\x1b[0m')).toBe('ok')
  })

  it('truncates excessively long stderr error lines', () => {
    const longError = `Error: ${'x'.repeat(500)}`
    const result = extractStderrSummary(longError, { maxChars: 80 })
    expect(result?.summary.length).toBeLessThanOrEqual(80)
    expect(result?.summary.endsWith('…')).toBe(true)
  })
})

describe('formatExitReason', () => {
  it('formats non-zero exit code with stderr summary in English and Chinese', () => {
    const detail = {
      info: { code: 1, signal: null },
      stderr: 'FATAL ERROR: JavaScript heap out of memory\n    at foo (bar.js:1:1)\n',
    }
    expect(formatExitReason(detail)).toBe(
      'Exited with code 1: FATAL ERROR: JavaScript heap out of memory',
    )

    setLocale('zh-CN')
    expect(formatExitReason(detail)).toBe(
      '进程已退出，退出码 1：FATAL ERROR: JavaScript heap out of memory',
    )
  })

  it('formats signal termination with and without stderr', () => {
    expect(formatExitReason({ info: { code: null, signal: 'SIGKILL' } })).toBe(
      'Stopped by signal SIGKILL.',
    )

    setLocale('zh-CN')
    expect(formatExitReason({ info: { code: null, signal: 'SIGKILL' } })).toBe(
      '进程被 SIGKILL 信号终止。',
    )
  })

  it('produces a targeted disk-full message when stderr reports no space left on device', () => {
    const detail = {
      info: { code: 1, signal: null },
      stderr: 'Error: ENOSPC: no space left on device, write\n    at write (node:fs:1:1)\n',
    }
    const en = formatExitReason(detail)
    expect(en).toContain('The disk is full.')
    expect(en).toContain('Exited with code 1: Error: ENOSPC: no space left on device, write')

    setLocale('zh-CN')
    const zh = formatExitReason(detail)
    expect(zh).toContain('磁盘空间不足')
    expect(zh).toContain('退出码 1')
    expect(zh).toContain('no space left on device')
  })

  it('surfaces disk-full guidance when host state writes are failing even without ENOSPC in stderr', () => {
    const en = formatExitReason({ info: { code: 1, signal: null }, stderr: '', diskFull: true })
    expect(en).toContain('The disk is full.')
    expect(en).toContain('Exited with code 1.')
  })

  it('returns undefined when no exit info or diagnostic detail is available', () => {
    expect(formatExitReason({})).toBeUndefined()
    expect(formatExitReason({ info: null, stderr: '' })).toBeUndefined()
  })
})
