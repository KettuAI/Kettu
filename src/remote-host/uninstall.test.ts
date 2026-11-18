import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPath, logFolderPath } from '../daemon/paths'
import { parseUninstallReport, uninstallRun } from './ssh'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * A home as the install script leaves it, with a `kettu` that records what it is asked and says
 * a daemon runs when `running` holds; and beside it what Kettu must never touch.
 */
function installedHome({ running = false } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'kettu-uninstall-'))
  homes.push(home)
  const versions = path.join(home, '.local', 'share', 'kettu', 'versions')
  const bin = path.join(versions, '0.1.9', 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(path.join(versions, '0.1.8', 'bin'), { recursive: true })
  const calls = path.join(home, 'calls')
  writeFileSync(
    path.join(bin, 'kettu'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${calls}'`,
      'case $1 in',
      `  status) exit ${running ? 0 : 3} ;;`,
      "  service) echo 'Removed the service; its daemon has stopped.' ;;",
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
  symlinkSync(path.join(bin, 'kettu'), path.join(home, '.local', 'bin', 'kettu'))
  const input = { platform: process.platform, home, env: {}, cwd: home }
  const data = dataPath(input)
  const logs = logFolderPath(input)
  mkdirSync(path.join(data, 'remote'), { recursive: true })
  writeFileSync(path.join(data, 'remote', 'identity.json'), '{}')
  mkdirSync(logs, { recursive: true })
  writeFileSync(path.join(logs, 'daemon.log'), 'log')
  const kept = [path.join(home, '.claude', 'settings.json'), path.join(home, 'code', 'app', 'x.ts')]
  for (const file of kept) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'mine')
  }
  return {
    home,
    versions,
    data,
    logs,
    calls,
    kept,
    link: path.join(home, '.local', 'bin', 'kettu'),
  }
}

/** Runs the script the app sends, as `sh -s` runs it over SSH, with nothing of this computer's. */
function uninstall(home: string, data: boolean, extraPath = '') {
  const run = spawnSync('sh', ['-s'], {
    input: uninstallRun(data),
    cwd: home,
    env: { HOME: home, PATH: `${extraPath}/usr/bin:/bin` },
    encoding: 'utf8',
  })
  return { code: run.status, output: run.stdout, report: parseUninstallReport(run.stdout) }
}

const exists = (file: string): boolean => {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

describe('the uninstall script', () => {
  it('removes the service, the link and the versions, and keeps the data unless asked', () => {
    const t = installedHome()
    const run = uninstall(t.home, false)
    expect(run.code).toBe(0)
    expect(run.report).toEqual({ done: true, foreign: null, running: false })
    expect(readFileSync(t.calls, 'utf8').split('\n')).toContain('service uninstall')
    expect(exists(t.link)).toBe(false)
    expect(exists(t.versions)).toBe(false)
    expect(existsSync(path.join(t.data, 'remote', 'identity.json'))).toBe(true)
    expect(existsSync(path.join(t.logs, 'daemon.log'))).toBe(true)
    for (const file of t.kept) expect(readFileSync(file, 'utf8')).toBe('mine')
  })

  it('deletes the data and log folders the daemon names when asked, and nothing of the agents', () => {
    const t = installedHome()
    const run = uninstall(t.home, true)
    expect(run.code).toBe(0)
    expect(run.report.done).toBe(true)
    expect(exists(t.link)).toBe(false)
    expect(exists(t.versions)).toBe(false)
    expect(exists(t.data)).toBe(false)
    expect(exists(t.logs)).toBe(false)
    expect(exists(t.home)).toBe(true)
    for (const file of t.kept) expect(readFileSync(file, 'utf8')).toBe('mine')
  })

  it('leaves alone a kettu link that does not point into the versions folder', () => {
    const t = installedHome()
    rmSync(t.link)
    const other = path.join(t.home, 'tools', 'kettu')
    mkdirSync(path.dirname(other), { recursive: true })
    writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 })
    symlinkSync(other, t.link)
    const run = uninstall(t.home, true)
    expect(run.code).not.toBe(0)
    expect(run.report).toEqual({ done: false, foreign: t.link, running: false })
    expect(lstatSync(t.link).isSymbolicLink()).toBe(true)
    expect(exists(other)).toBe(true)
    expect(exists(t.versions)).toBe(true)
    expect(exists(t.data)).toBe(true)
    expect(existsSync(t.calls)).toBe(false)
  })

  it('leaves alone a kettu that is a file of its own, or one on the PATH without the link', () => {
    const t = installedHome()
    rmSync(t.link)
    writeFileSync(t.link, '#!/bin/sh\n', { mode: 0o755 })
    const run = uninstall(t.home, true)
    expect(run.report.foreign).toBe(t.link)
    expect(readFileSync(t.link, 'utf8')).toBe('#!/bin/sh\n')
    expect(exists(t.versions)).toBe(true)

    rmSync(t.link)
    const brewed = path.join(t.home, 'opt', 'bin')
    mkdirSync(brewed, { recursive: true })
    writeFileSync(path.join(brewed, 'kettu'), '#!/bin/sh\n', { mode: 0o755 })
    const onPath = uninstall(t.home, true, `${brewed}:`)
    expect(onPath.report.foreign).toBe(path.join(brewed, 'kettu'))
    expect(exists(path.join(brewed, 'kettu'))).toBe(true)
    expect(exists(t.versions)).toBe(true)
    expect(exists(t.data)).toBe(true)
  })

  it('stops at the service when a daemon still runs outside it, keeping its files', () => {
    const t = installedHome({ running: true })
    const run = uninstall(t.home, true)
    expect(run.code).not.toBe(0)
    expect(run.report).toEqual({ done: false, foreign: null, running: true })
    expect(exists(t.link)).toBe(true)
    expect(exists(t.versions)).toBe(true)
    expect(exists(t.data)).toBe(true)
  })
})
