import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { isSqliteReadyForRead, statSqliteWithWal, withAgySqliteReadOnly } from './agy-sqlite'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-agy-sqlite-'))
  dirs.push(dir)
  return dir
}

describe('agy-sqlite read-only guard', () => {
  it('拒绝不存在、空文件、非 SQLite 头部与存在未提交回滚日志的数据库', async () => {
    const dir = await makeDir()
    const missing = path.join(dir, 'missing.db')
    expect(isSqliteReadyForRead(missing)).toBe(false)

    const empty = path.join(dir, 'empty.db')
    await writeFile(empty, Buffer.alloc(0))
    expect(isSqliteReadyForRead(empty)).toBe(false)

    const invalid = path.join(dir, 'invalid.db')
    await writeFile(invalid, Buffer.alloc(8192, 0x41))
    expect(isSqliteReadyForRead(invalid)).toBe(false)

    const ready = path.join(dir, 'ready.db')
    const db = new DatabaseSync(ready)
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);')
      db.prepare('INSERT INTO items VALUES (1, ?)').run('ok')
    } finally {
      db.close()
    }
    expect(isSqliteReadyForRead(ready)).toBe(true)

    // 存在非空回滚日志时应跳过读取，避免与宿主写事务冲突。
    await writeFile(`${ready}-journal`, Buffer.alloc(512, 1))
    expect(isSqliteReadyForRead(ready)).toBe(false)
    await rm(`${ready}-journal`)
    expect(isSqliteReadyForRead(ready)).toBe(true)
  })

  it('以只读短连接安全查询 WAL 数据库，并在 statSqliteWithWal 中忽略 0 字节空 WAL', async () => {
    const dir = await makeDir()
    const file = path.join(dir, 'wal.db')
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER);')
      db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 42)
    } finally {
      db.close()
    }

    const row = await withAgySqliteReadOnly(
      file,
      (conn) => conn.prepare('SELECT v FROM t WHERE k = ?').get('a') as { v: number } | undefined,
    )
    expect(row).toEqual({ v: 42 })

    // 写入 0 字节的空 WAL 文件不应改变增量签名。
    await writeFile(`${file}-wal`, Buffer.alloc(0))
    const statWithEmptyWal = await statSqliteWithWal(file)
    await rm(`${file}-wal`)
    const statWithoutWal = await statSqliteWithWal(file)
    expect(statWithEmptyWal).toEqual(statWithoutWal)

    // 写入非空 WAL 时复合大小应包含 WAL 字节数。
    await writeFile(`${file}-wal`, Buffer.alloc(128, 7))
    const statWithWal = await statSqliteWithWal(file)
    expect(statWithWal).not.toBeNull()
    expect(statWithWal!.size).toBe(statWithoutWal!.size + 128)
  })
})
