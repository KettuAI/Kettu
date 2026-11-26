// Per-session Antigravity (`agy`) app_data_dir resolution from conversation_summaries.db and
// trajectory files under `<home>/.gemini/<appDataDir>/conversations/`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGY_IDE_APP_DATA_DIR,
  agyAppDataDirOverride,
  agyGeminiDir,
  agySummariesDbFile,
  DEFAULT_AGY_APP_DATA_DIR,
  hasAgyTrajectory,
  IDE_AGY_APP_DATA_DIR,
  isSafeAgyAppDataDir,
  isSafeAgySessionId,
  offersSessionArg,
  readAgyAnnotationTitle,
  readAgyConversationMeta,
  resolveAgyAppDataDir,
  resolveAgyAppDataDirSync,
  SESSION_ARGS_META,
} from './agy-store'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-agy-store-'))
  dirs.push(dir)
  return dir
}

async function seedSummariesDb(
  home: string,
  rows: readonly { id: string; appDataDir: string; stepCount?: number }[],
): Promise<string> {
  const file = agySummariesDbFile(home, DEFAULT_AGY_APP_DATA_DIR)
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        step_count INTEGER NOT NULL DEFAULT 0,
        app_data_dir TEXT NOT NULL DEFAULT ''
      );
    `)
    const insert = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, step_count, app_data_dir) VALUES (?, ?, ?)',
    )
    for (const row of rows) insert.run(row.id, row.stepCount ?? 10, row.appDataDir)
  } finally {
    db.close()
  }
  return file
}

async function writeTrajectory(
  home: string,
  appDataDir: string,
  sessionId: string,
  ext: '.db' | '.pb' = '.db',
): Promise<void> {
  const dir = path.join(home, '.gemini', appDataDir, 'conversations')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${sessionId}${ext}`), 'trajectory')
}

describe('agy-store safety and helpers', () => {
  it('validates session ids and app_data_dir names against traversal and injection', () => {
    expect(isSafeAgySessionId('0ca066b0-19bc-4c18-bbd5-a3c3adbb1d25')).toBe(true)
    expect(isSafeAgySessionId('session_1.2')).toBe(true)
    expect(isSafeAgySessionId('')).toBe(false)
    expect(isSafeAgySessionId('.')).toBe(false)
    expect(isSafeAgySessionId('..')).toBe(false)
    expect(isSafeAgySessionId('../escape')).toBe(false)
    expect(isSafeAgySessionId('a/b')).toBe(false)
    expect(isSafeAgySessionId('a\\b')).toBe(false)
    expect(isSafeAgySessionId('bad id')).toBe(false)

    expect(isSafeAgyAppDataDir('antigravity')).toBe(true)
    expect(isSafeAgyAppDataDir('antigravity-cli')).toBe(true)
    expect(isSafeAgyAppDataDir('antigravity_ide.v2')).toBe(true)
    expect(isSafeAgyAppDataDir('')).toBe(false)
    expect(isSafeAgyAppDataDir('.')).toBe(false)
    expect(isSafeAgyAppDataDir('..')).toBe(false)
    expect(isSafeAgyAppDataDir('../etc')).toBe(false)
    expect(isSafeAgyAppDataDir('antigravity/sub')).toBe(false)
    expect(isSafeAgyAppDataDir('antigravity\\sub')).toBe(false)
    expect(isSafeAgyAppDataDir('antigravity --flag')).toBe(false)
  })

  it('builds platform-appropriate .gemini paths and checks router capability metadata', () => {
    expect(agyGeminiDir('/Users/me', 'darwin')).toBe('/Users/me/.gemini')
    expect(agyGeminiDir('C:\\Users\\me', 'win32')).toBe('C:\\Users\\me\\.gemini')
    expect(offersSessionArg({ [SESSION_ARGS_META]: ['--app-data-dir'] }, '--app-data-dir')).toBe(
      true,
    )
    expect(offersSessionArg({ [SESSION_ARGS_META]: ['--other'] }, '--app-data-dir')).toBe(false)
    expect(offersSessionArg(undefined, '--app-data-dir')).toBe(false)
  })
})

describe('resolveAgyAppDataDir', () => {
  it('reads app_data_dir and step_count from conversation_summaries.db', async () => {
    const home = await makeHome()
    await seedSummariesDb(home, [
      { id: 'ide-1', appDataDir: IDE_AGY_APP_DATA_DIR, stepCount: 42 },
      { id: 'cli-1', appDataDir: DEFAULT_AGY_APP_DATA_DIR, stepCount: 7 },
    ])
    await writeTrajectory(home, IDE_AGY_APP_DATA_DIR, 'ide-1', '.db')
    await writeTrajectory(home, DEFAULT_AGY_APP_DATA_DIR, 'cli-1', '.db')

    expect(await readAgyConversationMeta('ide-1', home)).toEqual({
      appDataDir: 'antigravity',
      stepCount: 42,
    })
    expect(await resolveAgyAppDataDir('ide-1', home)).toBe('antigravity')
    expect(await agyAppDataDirOverride('ide-1', home)).toBe('antigravity')

    expect(await resolveAgyAppDataDir('cli-1', home)).toBe('antigravity-cli')
    expect(await agyAppDataDirOverride('cli-1', home)).toBeNull()
  })

  it('falls back to filesystem trajectories (.db and legacy .pb) when summaries db is absent', async () => {
    const home = await makeHome()
    await writeTrajectory(home, IDE_AGY_APP_DATA_DIR, 'ide-db', '.db')
    await writeTrajectory(home, IDE_AGY_APP_DATA_DIR, 'ide-pb', '.pb')
    await writeTrajectory(home, DEFAULT_AGY_APP_DATA_DIR, 'cli-pb', '.pb')

    expect(await hasAgyTrajectory('ide-pb', IDE_AGY_APP_DATA_DIR, home)).toBe(true)
    expect(await resolveAgyAppDataDir('ide-db', home)).toBe('antigravity')
    expect(await resolveAgyAppDataDir('ide-pb', home)).toBe('antigravity')
    expect(await resolveAgyAppDataDir('cli-pb', home)).toBe('antigravity-cli')
    expect(await resolveAgyAppDataDir('missing-id', home)).toBeNull()

    expect(resolveAgyAppDataDirSync('ide-db', home)).toBe('antigravity')
    expect(resolveAgyAppDataDirSync('ide-pb', home)).toBe('antigravity')
    expect(resolveAgyAppDataDirSync('cli-pb', home)).toBe('antigravity-cli')
    expect(resolveAgyAppDataDirSync('missing-id', home)).toBeNull()
  })

  it('prefers actual trajectory location when DB app_data_dir is stale, and trusts DB when no file matches', async () => {
    const home = await makeHome()
    await seedSummariesDb(home, [
      { id: 'moved-to-ide', appDataDir: DEFAULT_AGY_APP_DATA_DIR },
      { id: 'moved-to-cli', appDataDir: IDE_AGY_APP_DATA_DIR },
      { id: 'db-only-custom', appDataDir: 'antigravity-ide' },
      { id: 'unsafe-db-dir', appDataDir: '../escape' },
    ])
    await writeTrajectory(home, IDE_AGY_APP_DATA_DIR, 'moved-to-ide', '.pb')
    await writeTrajectory(home, DEFAULT_AGY_APP_DATA_DIR, 'moved-to-cli', '.db')
    await writeTrajectory(home, IDE_AGY_APP_DATA_DIR, 'unsafe-db-dir', '.db')

    expect(await resolveAgyAppDataDir('moved-to-ide', home)).toBe('antigravity')
    expect(await resolveAgyAppDataDir('moved-to-cli', home)).toBe('antigravity-cli')
    expect(await resolveAgyAppDataDir('db-only-custom', home)).toBe('antigravity-ide')
    expect(await agyAppDataDirOverride('db-only-custom', home)).toBe('antigravity-ide')
    // Unsafe DB value is ignored and falls back to the trajectory on disk.
    expect(await resolveAgyAppDataDir('unsafe-db-dir', home)).toBe('antigravity')
  })

  it('supports isolated custom home directories (for added --gemini-dir accounts) and rejects unsafe ids', async () => {
    const accountHome = await makeHome()
    await seedSummariesDb(accountHome, [{ id: 'work-ide-1', appDataDir: IDE_AGY_APP_DATA_DIR }])
    await writeTrajectory(accountHome, IDE_AGY_APP_DATA_DIR, 'work-ide-1', '.db')

    expect(await agyAppDataDirOverride('work-ide-1', accountHome)).toBe('antigravity')
    expect(await agyAppDataDirOverride('../work-ide-1', accountHome)).toBeNull()
  })

  it('gracefully handles corrupt or legacy conversation_summaries.db without app_data_dir column', async () => {
    const home = await makeHome()
    const file = agySummariesDbFile(home, DEFAULT_AGY_APP_DATA_DIR)
    await mkdir(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    try {
      db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT);')
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('legacy-ide', 'Old')
    } finally {
      db.close()
    }
    await writeTrajectory(home, IDE_AGY_APP_DATA_DIR, 'legacy-ide', '.pb')

    expect(await readAgyConversationMeta('legacy-ide', home)).toBeNull()
    expect(await resolveAgyAppDataDir('legacy-ide', home)).toBe('antigravity')
  })

  it('支持探测 antigravity-ide 目录并从 annotations/*.pbtxt 读取真实会话标题', async () => {
    const home = await makeHome()
    await writeTrajectory(home, AGY_IDE_APP_DATA_DIR, 'ide-v2-session', '.db')
    expect(await resolveAgyAppDataDir('ide-v2-session', home)).toBe('antigravity-ide')
    expect(resolveAgyAppDataDirSync('ide-v2-session', home)).toBe('antigravity-ide')

    const annDir = path.join(home, '.gemini', AGY_IDE_APP_DATA_DIR, 'annotations')
    await mkdir(annDir, { recursive: true })
    await writeFile(
      path.join(annDir, 'ide-v2-session.pbtxt'),
      'title: "IDE \\344\\274\\232\\350\\257\\235"\n',
    )
    expect(await readAgyAnnotationTitle('ide-v2-session', home)).toBe('IDE 会话')
  })
})
