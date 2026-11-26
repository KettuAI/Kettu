// Antigravity (agy) 本地 SQLite 安全只读访问原语。
// 在 Windows 上，若外部进程在 agy 新建会话库执行 schema init / 切 WAL 的瞬间直接打开 SQLite，
// 可能持有 SHARED 锁并触发宿主 database is locked，导致整场会话永久降级为加密 .pb。
// 本模块通过无锁读取前 100 字节 SQLite 文件头确认库已就绪，再用短连接与 busy_timeout 读取，
// 读取完毕立即释放句柄，避免阻塞宿主写入或 WAL checkpoint。

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'

const SQLITE_MAGIC = 'SQLite format 3\0'
const SQLITE_HEADER_BYTES = 100
const SQLITE_MIN_BYTES = 4096
const SQLITE_WAL_HEADER_BYTES = 32
const BUSY_TIMEOUT_MS = 1000
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/** 校验目标 SQLite 文件是否已完成初始化，避免在建表或回滚日志事务途中加锁冲突。 */
export function isSqliteReadyForRead(dbPath: string): boolean {
  let info
  try {
    info = statSync(dbPath, { throwIfNoEntry: false })
  } catch {
    return false
  }
  if (!info || !info.isFile() || info.size < SQLITE_MIN_BYTES) return false

  // 若存在非空回滚日志，说明宿主正处于非 WAL 写事务中，此时跳过避免锁竞争。
  try {
    const journal = statSync(`${dbPath}-journal`, { throwIfNoEntry: false })
    if (journal && journal.size > 0) return false
  } catch {
    // 忽略瞬时探测错误。
  }

  let fd = -1
  try {
    fd = openSync(dbPath, 'r')
    const header = Buffer.allocUnsafe(SQLITE_HEADER_BYTES)
    const read = readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0)
    if (read < SQLITE_HEADER_BYTES) return false
    if (header.toString('latin1', 0, 16) !== SQLITE_MAGIC) return false

    const writeVersion = header[18]
    const readVersion = header[19]
    const pageCount = header.readUInt32BE(28)
    const schemaCookie = header.readUInt32BE(40)
    const committed = pageCount >= 2 && schemaCookie > 0
    if (committed) return true

    // WAL 模式下表结构可能尚未 checkpoint 到主库，检查 WAL 文件是否已有有效帧。
    if (writeVersion === 2 && readVersion === 2) {
      try {
        const wal = statSync(`${dbPath}-wal`, { throwIfNoEntry: false })
        return Boolean(wal && wal.size > SQLITE_WAL_HEADER_BYTES)
      } catch {
        return false
      }
    }
    return false
  } catch {
    return false
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        // 忽略关闭异常。
      }
    }
  }
}

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const errcode = (error as { errcode?: unknown }).errcode
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff
    if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return true
  }
  const message = String((error as { message?: unknown }).message ?? '')
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)
}

/**
 * 以只读短连接安全打开 SQLite 数据库并执行查询。
 * 打开前先经无锁头部检查；遇瞬时锁竞争时自动重试一次；未就绪或不存在时返回 null。
 */
export async function withAgySqliteReadOnly<T>(
  dbPath: string,
  query: (db: DatabaseSync) => T,
): Promise<T | null> {
  if (!isSqliteReadyForRead(dbPath)) return null
  const { DatabaseSync: Ctor } = await import('node:sqlite')
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: DatabaseSync | null = null
    try {
      db = new Ctor(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
      try {
        db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
      } catch {
        // 忽略在受限环境下的 PRAGMA 失败，仍由构造器 timeout 兜底。
      }
      return query(db)
    } catch (error) {
      if (attempt === 0 && isBusyError(error)) continue
      throw error
    } finally {
      if (db) {
        try {
          db.close()
        } catch {
          // 忽略关闭异常。
        }
      }
    }
  }
  return null
}

export interface SqliteWalStat {
  /** 用于增量游标比较的复合字节数（主库 + 非空 WAL）。 */
  size: number
  /** 主库与非空 WAL 中的最新修改时间（纳秒）。 */
  mtimeNs: bigint
  /** 扫描进度展示用的总字节数。 */
  bytes: number
}

/**
 * 获取 SQLite 主库及其 WAL 文件的复合修改签名。
 * 忽略 0 字节空 `.db-wal` 的修改时间，防止只读打开触发无效重扫。
 */
export async function statSqliteWithWal(dbPath: string): Promise<SqliteWalStat | null> {
  let dbStat
  try {
    dbStat = await stat(dbPath, { bigint: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  if (!dbStat.isFile()) return null

  let walSize = 0n
  let walMtimeNs = 0n
  try {
    const walStat = await stat(`${dbPath}-wal`, { bigint: true })
    if (walStat.isFile() && walStat.size > 0n) {
      walSize = walStat.size
      walMtimeNs = walStat.mtimeNs
    }
  } catch {
    // WAL 不存在或不可访问时仅使用主库签名。
  }

  const totalBytes = Number(dbStat.size + walSize)
  const mtimeNs = walMtimeNs > dbStat.mtimeNs ? walMtimeNs : dbStat.mtimeNs
  return { size: totalBytes, mtimeNs, bytes: totalBytes }
}
