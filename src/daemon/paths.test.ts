import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { controlSocketPath, dataPath } from './paths'

const home = path.resolve('/home/ada')

describe('dataPath', () => {
  it('is Kettu Daemon in Application Support on macOS, apart from the app', () => {
    expect(dataPath({ platform: 'darwin', home, env: {}, cwd: home })).toBe(
      path.join(home, 'Library', 'Application Support', 'Kettu Daemon'),
    )
  })

  it('is kettu in the XDG data folder on Linux', () => {
    expect(dataPath({ platform: 'linux', home, env: {}, cwd: home })).toBe(
      path.join(home, '.local', 'share', 'kettu'),
    )
    const xdg = path.resolve('/data/ada')
    expect(dataPath({ platform: 'linux', home, env: { XDG_DATA_HOME: xdg }, cwd: home })).toBe(
      path.join(xdg, 'kettu'),
    )
  })

  it('ignores a relative XDG_DATA_HOME, as the spec says', () => {
    expect(dataPath({ platform: 'linux', home, env: { XDG_DATA_HOME: 'data' }, cwd: home })).toBe(
      path.join(home, '.local', 'share', 'kettu'),
    )
  })

  it('takes KETTU_DAEMON_DATA over the default, resolved from the working folder', () => {
    const cwd = path.resolve('/work')
    for (const platform of ['darwin', 'linux'] as const) {
      expect(dataPath({ platform, home, env: { KETTU_DAEMON_DATA: 'tmp/d' }, cwd })).toBe(
        path.join(cwd, 'tmp', 'd'),
      )
      expect(dataPath({ platform, home, env: { KETTU_DAEMON_DATA: '  ' }, cwd })).not.toContain(cwd)
    }
  })
})

describe('controlSocketPath', () => {
  it('is control.sock in the data folder', () => {
    expect(controlSocketPath(path.join(home, 'kettu'))).toBe(
      path.join(home, 'kettu', 'control.sock'),
    )
  })

  it('is null when the path does not fit a Unix socket', () => {
    expect(controlSocketPath(path.join(home, 'x'.repeat(100)))).toBeNull()
  })
})
