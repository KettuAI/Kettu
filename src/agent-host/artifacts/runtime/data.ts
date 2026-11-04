// Each artifact's data: collections of JSON documents that its pages and the agents read and write
// alike, kept on the host beside the artifact and in no version. Every read and write goes
// through `mayUseData`, the one place who may use an artifact's data is decided.

import { ArtifactError, type ArtifactStore } from '../store'
import { ThreadStoreError } from '../../threads/store'
import type { DataDoc, DataFilter, DataOrder } from './calls'
import { CapabilityError } from './dispatcher'

const MIB = 1024 * 1024
export const DOC_BYTES = MIB
export const DATA_BYTES = 256 * MIB
export const LIST_LIMIT = 1_000
export const LIST_DEFAULT = 100
export const FILTERS = 8
const DEPTH = 64
const FIELD_SEGMENTS = 8

export const COLLECTION = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
export const DOC_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:@+-]{0,199}$/
const FIELD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>='])

/** Who uses an artifact's data: today always the host's owner, from a page or a session. */
export interface DataActor {
  person: 'owner'
  /** The session whose agent made the call; null for a page. */
  session: string | null
}

export const PAGE_ACTOR: DataActor = { person: 'owner', session: null }

/** A read or write of an artifact's data, as `mayUseData` decides it. */
export interface DataAccess {
  actor: DataActor
  artifactId: string
  access: 'read' | 'write'
}

/**
 * Whether the access is allowed. The owner may read and write everything; with several people
 * this is where rules by path and role go.
 */
export function mayUseData(request: DataAccess): boolean {
  return request.actor.person === 'owner'
}

/** Where a call reaches: a session's project, or anywhere for a page, which its artifact names. */
export interface DataReach {
  id: string
  project: string | null
}

export type DataChange =
  | { type: 'set'; collection: string; id: string; value: unknown; version: number }
  | { type: 'delete'; collection: string; id: string }

function invalid(message: string): CapabilityError {
  return new CapabilityError('invalid', message)
}

export function checkCollection(value: unknown): string {
  if (typeof value !== 'string' || !COLLECTION.test(value)) {
    throw invalid(
      'collection must be 1 to 64 letters, digits or _ . -, starting with a letter, digit or _.',
    )
  }
  return value
}

export function checkDocId(value: unknown): string {
  if (typeof value !== 'string' || !DOC_ID.test(value)) {
    throw invalid(
      'id must be 1 to 200 letters, digits or _ . : @ + -, starting with a letter, digit or _.',
    )
  }
  return value
}

function checkField(value: unknown, label: string): string {
  const segments = typeof value === 'string' ? value.split('.') : []
  if (
    segments.length === 0 ||
    segments.length > FIELD_SEGMENTS ||
    !segments.every((segment) => FIELD_SEGMENT.test(segment))
  ) {
    throw invalid(`${label} must be a field name, or names joined by dots such as owner.name.`)
  }
  return value as string
}

export function checkBase(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('baseVersion must be the version you read, or 0 for a new document.')
  }
  return value
}

export function checkLimit(value: unknown, fallback = LIST_DEFAULT): number {
  if (value === undefined || value === null) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > LIST_LIMIT
  ) {
    throw invalid(`limit must be a whole number from 1 to ${LIST_LIMIT}.`)
  }
  return value
}

/** The value as the JSON a document stores, refused when it is none or too deep or large. */
export function documentJson(value: unknown): string {
  const deep = (item: unknown, depth: number): boolean => {
    if (depth > DEPTH) return true
    if (typeof item !== 'object' || item === null) return false
    return Object.values(item).some((child) => deep(child, depth + 1))
  }
  if (value === undefined || deep(value, 0)) {
    throw invalid(`A document's value must be JSON, nested at most ${DEPTH} deep.`)
  }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (json === undefined) throw invalid("A document's value must be JSON.")
  if (Buffer.byteLength(json, 'utf8') > DOC_BYTES) {
    throw new CapabilityError('too_large', 'A document may be at most 1 MiB as JSON.')
  }
  return json
}

export function checkFilters(value: unknown): DataFilter[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > FILTERS) {
    throw invalid(`where must be a list of at most ${FILTERS} filters.`)
  }
  return value.map((item: unknown, i) => {
    const filter = Array.isArray(item)
      ? { field: item[0], op: item[1], value: item[2] }
      : ((item ?? {}) as Record<string, unknown>)
    const label = `where[${i}]`
    const field = checkField(filter.field, `${label}'s field`)
    if (typeof filter.op !== 'string' || !OPS.has(filter.op)) {
      throw invalid(`${label}'s op must be one of == != < <= > >=.`)
    }
    const compared = filter.value
    const plain =
      compared === null ||
      typeof compared === 'boolean' ||
      typeof compared === 'string' ||
      (typeof compared === 'number' && Number.isFinite(compared))
    if (!plain) throw invalid(`${label}'s value must be a string, number, boolean or null.`)
    if (compared === null && filter.op !== '==' && filter.op !== '!=') {
      throw invalid(`${label} compares with null, which only == and != do.`)
    }
    return { field, op: filter.op as DataFilter['op'], value: compared as DataFilter['value'] }
  })
}

export function checkOrder(value: unknown): DataOrder | null {
  if (value === undefined || value === null) return null
  const order = Array.isArray(value)
    ? { field: value[0], direction: value[1] }
    : typeof value === 'string'
      ? { field: value, direction: 'asc' }
      : (value as Record<string, unknown>)
  const field = checkField(order.field, 'orderBy')
  const direction = order.direction ?? 'asc'
  if (direction !== 'asc' && direction !== 'desc') {
    throw invalid("orderBy's direction must be asc or desc.")
  }
  return { field, direction }
}

export interface ArtifactDataDeps {
  store: Pick<ArtifactStore, 'runtime'>
  now?: () => number
}

export class ArtifactData {
  private readonly listeners = new Map<string, Set<(change: DataChange) => void>>()

  constructor(private readonly deps: ArtifactDataDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private check(actor: DataActor, id: string, access: 'read' | 'write'): void {
    if (!mayUseData({ actor, artifactId: id, access })) {
      throw new CapabilityError('not_allowed', `You may not ${access} this artifact's data.`)
    }
  }

  /** A store call, its refusals as the page and the tools are told them. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof ArtifactError) {
        if (error.reason === 'conflict' && error.state) {
          throw new CapabilityError(
            'conflict',
            error.state.version === 0
              ? 'The document is not there any more. Read it again before you write it.'
              : `The document is at version ${error.state.version}. Read it again and write from that version.`,
          )
        }
        if (error.reason === 'deleted') {
          throw new CapabilityError('not_found', 'The artifact is in Recently deleted.')
        }
        throw new CapabilityError('not_found', error.message)
      }
      if (error instanceof ThreadStoreError) {
        if (error.code === 'too_large') {
          throw new CapabilityError(
            'too_large',
            "The write would take a document past 1 MiB or the artifact's data past 256 MiB.",
          )
        }
        if (error.code === 'invalid') throw invalid(error.message)
      }
      throw error
    }
  }

  private changed(id: string, change: DataChange): void {
    for (const listener of this.listeners.get(id) ?? []) listener(change)
  }

  get(actor: DataActor, reach: DataReach, collection: string, docId: string) {
    this.check(actor, reach.id, 'read')
    return this.run(() => this.deps.store.runtime('dataGet', { ...reach, collection, docId }))
  }

  /** Writes the whole document, or with `merge` its fields into the object it holds. */
  async put(
    actor: DataActor,
    reach: DataReach,
    input: {
      collection: string
      docId: string
      value: unknown
      merge: boolean
      baseVersion: number | null
    },
  ): Promise<DataDoc> {
    this.check(actor, reach.id, 'write')
    if (input.merge && (typeof input.value !== 'object' || input.value === null)) {
      throw invalid('patch must be an object of the fields to change.')
    }
    const json = documentJson(input.value)
    const doc = await this.run(() =>
      this.deps.store.runtime('dataPut', {
        ...reach,
        collection: input.collection,
        docId: input.docId,
        mode: input.merge ? 'merge' : 'set',
        json,
        baseVersion: input.baseVersion,
        docLimit: DOC_BYTES,
        limit: DATA_BYTES,
        at: this.now(),
      }),
    )
    this.changed(reach.id, {
      type: 'set',
      collection: doc.collection,
      id: doc.id,
      value: doc.value,
      version: doc.version,
    })
    return doc
  }

  async delete(
    actor: DataActor,
    reach: DataReach,
    collection: string,
    docId: string,
    baseVersion: number | null,
  ): Promise<{ deleted: boolean }> {
    this.check(actor, reach.id, 'write')
    const result = await this.run(() =>
      this.deps.store.runtime('dataDelete', { ...reach, collection, docId, baseVersion }),
    )
    if (result.deleted) this.changed(reach.id, { type: 'delete', collection, id: docId })
    return result
  }

  list(
    actor: DataActor,
    reach: DataReach,
    collection: string,
    after: string | null,
    limit: number,
  ) {
    this.check(actor, reach.id, 'read')
    return this.run(() =>
      this.deps.store.runtime('dataList', { ...reach, collection, after, limit }),
    )
  }

  query(
    actor: DataActor,
    reach: DataReach,
    collection: string,
    where: DataFilter[],
    orderBy: DataOrder | null,
    limit: number,
  ) {
    this.check(actor, reach.id, 'read')
    return this.run(() =>
      this.deps.store.runtime('dataQuery', { ...reach, collection, where, orderBy, limit }),
    )
  }

  collections(actor: DataActor, reach: DataReach) {
    this.check(actor, reach.id, 'read')
    return this.run(() => this.deps.store.runtime('dataCollections', reach))
  }

  /** Calls `listener` with each change of the artifact's data, of one collection or all. */
  watch(
    actor: DataActor,
    artifactId: string,
    collection: string | null,
    listener: (change: DataChange) => void,
  ): () => void {
    this.check(actor, artifactId, 'read')
    let set = this.listeners.get(artifactId)
    if (!set) this.listeners.set(artifactId, (set = new Set()))
    const filtered = (change: DataChange): void => {
      if (collection === null || change.collection === collection) listener(change)
    }
    set.add(filtered)
    return () => {
      set.delete(filtered)
      if (set.size === 0 && this.listeners.get(artifactId) === set) {
        this.listeners.delete(artifactId)
      }
    }
  }
}
