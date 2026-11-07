import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DiagnosticsBundle, SessionSummary } from '../agent-host'
import { parseReportRequest, ReportRequestError, type ReportExtra } from '../report'
import { DEFAULT_SETTINGS, type SettingsFile } from '../settings'
import { buildReportFiles, settingsForReport, type ReportParts } from './report-bundle'
import { createRedactor } from './redact'

const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kettu-report-test-'))
  dirs.push(dir)
  return dir
}

function line(minutesAgo: number, message: string): string {
  const time = new Date(NOW - minutesAgo * 60_000).toISOString()
  return JSON.stringify({ time, level: 'info', process: 'agent-host', source: 'test', message })
}

const session = {
  id: 's1',
  agentId: 'claude-code',
  title: 'Fix the login page of acme-secret-project',
  projectPath: '/Users/ann/work/acme',
  description: 'about the acme deal',
  branch: 'feat/acme',
  pr: null,
  scratch: false,
  status: 'idle',
  attention: null,
  permissionCount: 0,
  createdAt: NOW - 1000,
  updatedAt: NOW,
  parentId: null,
  origin: null,
  missing: false,
  model: null,
  archivedAt: null,
} as unknown as SessionSummary

const host = {
  createdAt: NOW,
  appVersion: '0.0.25',
  platform: 'darwin',
  environment: { PATH: '/Users/ann/bin:/usr/bin', SHELL: '/bin/zsh', node: '24.0.0' },
  environmentInfo: {},
  agents: [
    {
      status: { id: 'claude-code' },
      capabilities: {},
      traffic: [{ at: NOW, direction: 'out', message: { prompt: 'deploy with my key' } }],
      stderr: '',
      events: [],
      adapter: null,
    },
  ],
  sessions: [session],
  log: [],
} as unknown as DiagnosticsBundle

const settings: SettingsFile = {
  ...structuredClone(DEFAULT_SETTINGS),
  proxy: { mode: 'custom', url: 'http://ann:pa55word@proxy.example.com:8080', noProxy: '' },
  addedAgents: [
    { id: 'claude-code~work', name: 'Ann at Acme', configDir: '/Users/ann/.acme', created: true },
  ],
  thread: {
    ...DEFAULT_SETTINGS.thread,
    alwaysOpenIn: { 'https://bank.example.com': 'browser' },
  },
  remote: {
    ...DEFAULT_SETTINGS.remote,
    name: "Ann's MacBook",
    direct: { enabled: true, port: 60021, addresses: [{ host: 'home.example.com', port: 60021 }] },
  },
} as SettingsFile

async function parts(extras: ReportExtra[]): Promise<ReportParts> {
  const logDir = await folder()
  await writeFile(
    path.join(logDir, 'agent-host.log'),
    [line(90, 'before the range'), line(5, `started in /Users/ann/work with ${KEY}`)].join('\n'),
  )
  await writeFile(path.join(logDir, 'verbose-agent-host.log'), `${line(5, 'a whole prompt')}\n`)
  const crashDir = await folder()
  await writeFile(path.join(crashDir, 'one.dmp'), 'MDMP')
  // Written within the range, whatever the clock says now.
  const written = new Date(NOW - 5 * 60_000)
  for (const file of ['agent-host.log', 'verbose-agent-host.log']) {
    await utimes(path.join(logDir, file), written, written)
  }
  await utimes(path.join(crashDir, 'one.dmp'), written, written)
  return {
    request: {
      description: `It froze, my key is ${KEY}`,
      range: { kind: 'hour' },
      extras,
      context: null,
    },
    now: NOW,
    parent: { app: { version: '0.0.25' } },
    settings,
    host,
    logDir,
    crashDir,
    screenshot: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    redact: createRedactor({ home: '/Users/ann', platform: 'darwin' }),
  }
}

function text(files: Map<string, string | Uint8Array>): string {
  return [...files.values()].filter((value) => typeof value === 'string').join('\n')
}

describe('buildReportFiles', () => {
  it('holds the facts and the range of the logs, and nothing chosen when nothing is', async () => {
    const files = await buildReportFiles(await parts([]))
    expect([...files.keys()].sort()).toEqual([
      'agents.json',
      'host-log.json',
      'logs/agent-host.log',
      'report.json',
      'sessions.json',
      'settings.json',
    ])
    const log = files.get('logs/agent-host.log') as string
    expect(log).toContain('started in')
    expect(log).not.toContain('before the range')
  })

  it('masks keys and the home folder in every text file, the description too', async () => {
    const files = await buildReportFiles(
      await parts(['titles', 'messages', 'verbose', 'dumps', 'screenshot']),
    )
    const all = text(files)
    expect(all).not.toContain('sk-ant-')
    expect(all).not.toContain('/Users/ann')
    expect(files.get('logs/agent-host.log')).toContain('~/work')
  })

  it('leaves out titles, projects and branches unless they are chosen', async () => {
    const without = JSON.parse(
      (await buildReportFiles(await parts([]))).get('sessions.json') as string,
    )
    expect(without[0]).not.toHaveProperty('title')
    expect(without[0]).not.toHaveProperty('projectPath')
    expect(without[0]).not.toHaveProperty('description')
    expect(without[0]).not.toHaveProperty('branch')
    expect(JSON.stringify(without)).not.toContain('acme')
    const titled = (await buildReportFiles(await parts(['titles']))).get('sessions.json') as string
    expect(titled).toContain('acme-secret-project')
  })

  it('adds messages, the detailed records, dumps and the screenshot only when chosen', async () => {
    const chosen = await buildReportFiles(
      await parts(['messages', 'verbose', 'dumps', 'screenshot']),
    )
    expect(chosen.get('messages/claude-code.json')).toContain('deploy with my key')
    expect(chosen.get('logs/verbose-agent-host.log')).toContain('a whole prompt')
    expect(chosen.get('crash/one.dmp')).toBeInstanceOf(Uint8Array)
    expect(chosen.get('screenshot.png')).toBeInstanceOf(Uint8Array)
    const none = await buildReportFiles(await parts(['titles']))
    expect(text(none)).not.toContain('deploy with my key')
    expect(text(none)).not.toContain('a whole prompt')
    expect([...none.keys()].some((name) => /^(messages|crash)\/|screenshot/.test(name))).toBe(false)
  })
})

describe('settingsForReport', () => {
  it('drops who the user is and where they go, and keeps how things are set up', () => {
    const shown = JSON.stringify(settingsForReport(settings))
    for (const kept of ['pa55word', 'ann:', 'Ann at Acme', "Ann's MacBook", 'bank.example.com']) {
      expect(shown).not.toContain(kept)
    }
    expect(shown).not.toContain('home.example.com')
    expect(shown).toContain('proxy.example.com:8080')
    expect(shown).toContain('/Users/ann/.acme')
  })
})

describe('parseReportRequest', () => {
  const valid = { description: ' It froze ', range: { kind: 'today' }, extras: ['verbose'] }

  it('keeps a valid request, trimmed, with each extra once', () => {
    expect(parseReportRequest({ ...valid, extras: ['verbose', 'verbose'], context: null })).toEqual(
      {
        description: 'It froze',
        range: { kind: 'today' },
        extras: ['verbose'],
        context: null,
      },
    )
  })

  it('refuses what the dialog never sends', () => {
    const bad: unknown[] = [
      null,
      { ...valid, description: '   ' },
      { ...valid, description: 'x'.repeat(10_001) },
      { ...valid, extras: ['passwords'] },
      { ...valid, extras: 'verbose' },
      { ...valid, range: { kind: 'week' } },
      { ...valid, range: { kind: 'span', from: NOW, to: NOW + 3 * 24 * 3_600_000 } },
      { ...valid, range: { kind: 'span', from: NOW, to: NOW - 1 } },
      { ...valid, context: { sessionId: 7 } },
      { ...valid, context: { error: 'e'.repeat(4_001) } },
    ]
    for (const value of bad) expect(() => parseReportRequest(value)).toThrow(ReportRequestError)
  })
})
