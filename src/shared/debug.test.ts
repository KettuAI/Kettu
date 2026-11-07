import { describe, expect, it } from 'vitest'
import { debugRun, type DebugSwitches } from './debug'

const none: DebugSwitches = {
  debug: null,
  remoteDebuggingPort: null,
  remoteDebuggingPipe: false,
  env: undefined,
}

describe('debugRun', () => {
  describe('in an installed build', () => {
    it('opens nothing without a debug switch, whatever the environment says', () => {
      expect(debugRun(none, true)).toEqual({ on: false })
      expect(debugRun({ ...none, env: '1' }, true)).toEqual({ on: false })
      expect(debugRun({ ...none, env: '9241' }, true)).toEqual({ on: false })
    })

    it('takes --debug with a free port, or the port it names', () => {
      expect(debugRun({ ...none, debug: '' }, true)).toEqual({ on: true, cdp: 0 })
      expect(debugRun({ ...none, debug: '9241' }, true)).toEqual({ on: true, cdp: 9241 })
    })

    it.each(['80', '1023', '65536', 'abc', '9241x', '-1', '0'])(
      'replaces the port %j with a free one and says why',
      (value) => {
        const run = debugRun({ ...none, debug: value }, true)
        expect(run).toMatchObject({ on: true, cdp: 0 })
        expect(run.on && run.problem).toMatch(/1024 to 65535/)
      },
    )

    it('treats a debugging port or pipe passed in as a debug run, which Chromium opens', () => {
      expect(debugRun({ ...none, remoteDebuggingPort: '9222' }, true)).toEqual({
        on: true,
        cdp: null,
      })
      expect(debugRun({ ...none, remoteDebuggingPort: '0' }, true)).toEqual({ on: true, cdp: null })
      expect(debugRun({ ...none, remoteDebuggingPipe: true }, true)).toEqual({
        on: true,
        cdp: null,
      })
      expect(debugRun({ ...none, debug: '9241', remoteDebuggingPort: '9222' }, true)).toEqual({
        on: true,
        cdp: null,
      })
    })
  })

  describe('in a development run', () => {
    it('keeps its own debugging port as a plain development port', () => {
      expect(debugRun({ ...none, remoteDebuggingPort: '9222' }, false)).toEqual({ on: false })
      expect(debugRun({ ...none, remoteDebuggingPipe: true }, false)).toEqual({ on: false })
    })

    it('takes KETTU_DEBUG in place of --debug, which Node.js refuses there', () => {
      expect(debugRun({ ...none, debug: '' }, false)).toEqual({ on: false })
      expect(debugRun({ ...none, env: '1' }, false)).toEqual({ on: true, cdp: 0 })
      expect(debugRun({ ...none, env: '9241' }, false)).toEqual({ on: true, cdp: 9241 })
      expect(debugRun({ ...none, env: '  ' }, false)).toEqual({ on: false })
      expect(debugRun({ ...none, env: '1', remoteDebuggingPort: '9222' }, false)).toEqual({
        on: true,
        cdp: null,
      })
    })
  })
})
