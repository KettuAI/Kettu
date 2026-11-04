// The page runtime's tables in the thread database: each version's declaration, each artifact's
// data and the user's consents. Runs in the thread worker, inside ThreadDb's error handling.

import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'
import { RUNTIME_VERSION } from '@shared/artifact-capabilities'
import type { ArtifactState } from '@shared/artifacts'
import type {
  DataDoc,
  DataFilter,
  Declaration,
  DeclaredArtifact,
  RuntimeCall,
  RuntimeCalls,
} from '../artifacts/runtime/calls'
import type { ThreadErrorCode } from './protocol'

// Every version written since has a declaration; one without declares nothing and was written
// for the first runtime. A document's version comes from its artifact's `seq`, so a document
// made again after a delete never takes a version an earlier one had.
export const RUNTIME_TABLES = `
  CREATE TABLE artifact_runtime (
    artifact_id  TEXT NOT NULL,
    n            INTEGER NOT NULL,
    capabilities TEXT NOT NULL,
    runtime      INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, n),
    FOREIGN KEY (artifact_id, n) REFERENCES artifact_versions (artifact_id, n) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE artifact_data (
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    collection  TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    json        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    version     INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, collection, doc_id)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE artifact_data_totals (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts (id) ON DELETE CASCADE,
    bytes       INTEGER NOT NULL,
    seq         INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE artifact_consents (
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    capability  TEXT NOT NULL,
    granted_at  INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, capability)
  ) STRICT, WITHOUT ROWID;
`

type Row = Record<string, SQLOutputValue>

/** How a call fails: the same errors ThreadDb throws, with the state a conflict found. */
export type RuntimeFail = (message: string, code: ThreadErrorCode, data?: ArtifactState) => Error

export function prepareRuntime(db: DatabaseSync) {
  const sql = (text: string): StatementSync => db.prepare(text)
  return {
    artifact: sql('SELECT id, project, title, head, deleted_at FROM artifacts WHERE id = ?'),
    hasVersion: sql('SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND n = ?'),
    declaration: sql(
      'SELECT capabilities, runtime FROM artifact_runtime WHERE artifact_id = ? AND n = ?',
    ),
    putDeclaration: sql(
      'INSERT INTO artifact_runtime (artifact_id, n, capabilities, runtime) VALUES (?, ?, ?, ?)',
    ),
    doc: sql(
      'SELECT collection, doc_id, json, size, version, updated_at FROM artifact_data WHERE artifact_id = ? AND collection = ? AND doc_id = ?',
    ),
    putDoc: sql(`
      INSERT INTO artifact_data (artifact_id, collection, doc_id, json, size, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (artifact_id, collection, doc_id) DO UPDATE SET
        json = excluded.json, size = excluded.size, version = excluded.version,
        updated_at = excluded.updated_at`),
    deleteDoc: sql(
      'DELETE FROM artifact_data WHERE artifact_id = ? AND collection = ? AND doc_id = ?',
    ),
    totals: sql('SELECT bytes, seq FROM artifact_data_totals WHERE artifact_id = ?'),
    putTotals: sql(`
      INSERT INTO artifact_data_totals (artifact_id, bytes, seq) VALUES (?, ?, ?)
      ON CONFLICT (artifact_id) DO UPDATE SET bytes = excluded.bytes, seq = excluded.seq`),
    list: sql(`
      SELECT collection, doc_id, json, size, version, updated_at FROM artifact_data
      WHERE artifact_id = ? AND collection = ? AND doc_id > ? ORDER BY doc_id LIMIT ?`),
    collections: sql(`
      SELECT collection, COUNT(*) AS n FROM artifact_data WHERE artifact_id = ?
      GROUP BY collection ORDER BY collection`),
    consentOf: sql(
      'SELECT capability FROM artifact_consents WHERE artifact_id = ? ORDER BY capability',
    ),
    grant: sql(
      'INSERT OR IGNORE INTO artifact_consents (artifact_id, capability, granted_at) VALUES (?, ?, ?)',
    ),
    revoke: sql('DELETE FROM artifact_consents WHERE artifact_id = ?'),
    consents: sql(`
      SELECT a.id, a.title, a.project, group_concat(c.capability) AS capabilities
      FROM artifact_consents c JOIN artifacts a ON a.id = c.artifact_id
      WHERE a.deleted_at IS NULL GROUP BY a.id ORDER BY a.title COLLATE NOCASE, a.id`),
  }
}

export type RuntimeStatements = ReturnType<typeof prepareRuntime>

/** What a version declares; one written before declarations declares nothing. */
export function declarationAt(sql: RuntimeStatements, id: string, n: number): Declaration {
  const row = sql.declaration.get(id, n)
  if (!row) return { capabilities: [], runtime: RUNTIME_VERSION }
  return {
    capabilities: JSON.parse(String(row.capabilities)) as string[],
    runtime: Number(row.runtime),
  }
}

export function putDeclaration(
  sql: RuntimeStatements,
  id: string,
  n: number,
  declaration: Declaration,
): void {
  sql.putDeclaration.run(id, n, JSON.stringify(declaration.capabilities), declaration.runtime)
}

function docOf(row: Row): DataDoc {
  return {
    collection: String(row.collection),
    id: String(row.doc_id),
    value: JSON.parse(String(row.json)) as unknown,
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  }
}

/** A field's dotted path as a JSON path; the host checked each segment is a plain name. */
function jsonPath(field: string): string {
  return `$${field
    .split('.')
    .map((segment) => `."${segment}"`)
    .join('')}`
}

function bound(value: DataFilter['value']): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface RuntimeContext {
  db: DatabaseSync
  sql: RuntimeStatements
  transaction<T>(run: () => T): T
  fail: RuntimeFail
}

/** The artifact in reach, as for the artifact calls; `live` refuses one in Recently deleted. */
function artifactIn(
  ctx: RuntimeContext,
  id: string,
  project: string | null,
  live: boolean,
): { project: string; title: string; head: number; deleted: boolean } {
  const row = ctx.sql.artifact.get(id)
  if (!row || (project !== null && String(row.project) !== project)) {
    throw ctx.fail(`No artifact ${id}`, 'not_found')
  }
  const deleted = row.deleted_at !== null
  const head = Number(row.head)
  if (live && deleted) {
    throw ctx.fail(`${id} is in Recently deleted`, 'deleted', { version: head, deleted })
  }
  return { project: String(row.project), title: String(row.title), head, deleted }
}

/** Refuses a write unless the document is at `baseVersion`, 0 for one that must not exist. */
function fromBase(ctx: RuntimeContext, doc: DataDoc | null, baseVersion: number | null): void {
  if (baseVersion === null) return
  const current = doc?.version ?? 0
  if (current === baseVersion) return
  throw ctx.fail(
    doc
      ? `${doc.collection}/${doc.id} is at version ${current}, not ${baseVersion}`
      : `The document does not exist, so it is not at version ${baseVersion}`,
    'conflict',
    { version: current, deleted: false },
  )
}

function declaration(
  ctx: RuntimeContext,
  { id, project, version }: RuntimeCalls['declaration']['params'],
): DeclaredArtifact {
  const artifact = artifactIn(ctx, id, project, project !== null)
  const n = version ?? artifact.head
  if (!ctx.sql.hasVersion.get(id, n)) throw ctx.fail(`${id} has no version ${n}`, 'not_found')
  return {
    id,
    project: artifact.project,
    title: artifact.title,
    head: artifact.head,
    deleted: artifact.deleted,
    ...declarationAt(ctx.sql, id, n),
  }
}

function dataPut(ctx: RuntimeContext, params: RuntimeCalls['dataPut']['params']): DataDoc {
  return ctx.transaction(() => {
    artifactIn(ctx, params.id, params.project, true)
    const row = ctx.sql.doc.get(params.id, params.collection, params.docId)
    const previous = row ? docOf(row) : null
    fromBase(ctx, previous, params.baseVersion)
    let json = params.json
    if (params.mode === 'merge') {
      if (!previous) {
        throw ctx.fail(`There is no ${params.collection}/${params.docId} to update`, 'not_found')
      }
      const patch = JSON.parse(json) as unknown
      if (!isObject(previous.value) || !isObject(patch)) {
        throw ctx.fail('update merges an object into a document that holds one', 'invalid')
      }
      json = JSON.stringify({ ...previous.value, ...patch })
    }
    const size = Buffer.byteLength(json, 'utf8')
    if (size > params.docLimit) {
      throw ctx.fail(`The document would be ${size} bytes`, 'too_large')
    }
    const totals = ctx.sql.totals.get(params.id)
    const bytes = Number(totals?.bytes ?? 0) - Number(row?.size ?? 0) + size
    if (bytes > params.limit) {
      throw ctx.fail(`The artifact's data would be ${bytes} bytes`, 'too_large')
    }
    const version = Number(totals?.seq ?? 0) + 1
    ctx.sql.putDoc.run(params.id, params.collection, params.docId, json, size, version, params.at)
    ctx.sql.putTotals.run(params.id, bytes, version)
    return {
      collection: params.collection,
      id: params.docId,
      value: JSON.parse(json) as unknown,
      version,
      updatedAt: params.at,
    }
  })
}

function dataDelete(
  ctx: RuntimeContext,
  params: RuntimeCalls['dataDelete']['params'],
): { deleted: boolean } {
  return ctx.transaction(() => {
    artifactIn(ctx, params.id, params.project, true)
    const row = ctx.sql.doc.get(params.id, params.collection, params.docId)
    fromBase(ctx, row ? docOf(row) : null, params.baseVersion)
    if (!row) return { deleted: false }
    ctx.sql.deleteDoc.run(params.id, params.collection, params.docId)
    const totals = ctx.sql.totals.get(params.id)
    ctx.sql.putTotals.run(
      params.id,
      Math.max(0, Number(totals?.bytes ?? 0) - Number(row.size)),
      Number(totals?.seq ?? 0),
    )
    return { deleted: true }
  })
}

function dataQuery(ctx: RuntimeContext, params: RuntimeCalls['dataQuery']['params']): DataDoc[] {
  artifactIn(ctx, params.id, params.project, true)
  const clauses = ['artifact_id = ?', 'collection = ?']
  const values: SQLInputValue[] = [params.id, params.collection]
  for (const filter of params.where) {
    const field = 'json_extract(json, ?)'
    values.push(jsonPath(filter.field))
    if (filter.value === null) {
      if (filter.op !== '==' && filter.op !== '!=') {
        throw ctx.fail('A range filter needs a value that is not null', 'invalid')
      }
      clauses.push(`${field} ${filter.op === '==' ? 'IS NULL' : 'IS NOT NULL'}`)
      continue
    }
    // The operators are from a fixed list; values and paths are bound.
    clauses.push(`${field} ${filter.op === '==' ? '=' : filter.op} ?`)
    values.push(bound(filter.value))
  }
  let order = 'doc_id'
  if (params.orderBy) {
    order = `json_extract(json, ?) ${params.orderBy.direction === 'desc' ? 'DESC' : 'ASC'}, doc_id`
    values.push(jsonPath(params.orderBy.field))
  }
  values.push(params.limit)
  const rows = ctx.db
    .prepare(
      `SELECT collection, doc_id, json, size, version, updated_at FROM artifact_data
       WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    )
    .all(...values)
  return rows.map(docOf)
}

/** One runtime call, for the worker's `runtime` op. */
export function runtimeCall(ctx: RuntimeContext, call: RuntimeCall): unknown {
  const { sql } = ctx
  switch (call.name) {
    case 'declaration':
      return declaration(ctx, call.params)
    case 'dataGet': {
      const { id, project, collection, docId } = call.params
      artifactIn(ctx, id, project, true)
      const row = sql.doc.get(id, collection, docId)
      return row ? docOf(row) : null
    }
    case 'dataPut':
      return dataPut(ctx, call.params)
    case 'dataDelete':
      return dataDelete(ctx, call.params)
    case 'dataList': {
      const { id, project, collection, after, limit } = call.params
      artifactIn(ctx, id, project, true)
      const rows = sql.list.all(id, collection, after ?? '', limit + 1)
      const docs = rows.slice(0, limit).map(docOf)
      return { docs, next: rows.length > limit ? docs[docs.length - 1]!.id : null }
    }
    case 'dataQuery':
      return dataQuery(ctx, call.params)
    case 'dataCollections': {
      const { id, project } = call.params
      artifactIn(ctx, id, project, true)
      return {
        collections: sql.collections
          .all(id)
          .map((row) => ({ name: String(row.collection), count: Number(row.n) })),
        bytes: Number(sql.totals.get(id)?.bytes ?? 0),
      }
    }
    case 'consentOf':
      return sql.consentOf.all(call.params.id).map((row) => String(row.capability))
    case 'consentGrant': {
      const { id, capability, at } = call.params
      artifactIn(ctx, id, null, true)
      sql.grant.run(id, capability, at)
      return null
    }
    case 'consentRevoke':
      return { changed: Number(sql.revoke.run(call.params.id).changes) > 0 }
    case 'consents':
      return sql.consents.all().map((row) => ({
        id: String(row.id),
        title: String(row.title),
        project: String(row.project),
        capabilities: String(row.capabilities).split(',').sort(),
      }))
  }
}
