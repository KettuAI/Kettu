// `db`: the artifact's own documents, for its pages. Needs no consent, since the data never
// leaves the artifact; the agents read and write the same documents through their tools.

import {
  ArtifactData,
  checkBase,
  checkCollection,
  checkDocId,
  checkFilters,
  checkLimit,
  checkOrder,
  PAGE_ACTOR,
  type DataChange,
} from './data'
import { CapabilityError, type CapabilityContext, type CapabilityHandler } from './dispatcher'

const OPS = ['get', 'set', 'update', 'delete', 'list', 'query', 'collections', 'watch'] as const

const fields = (args: unknown): Record<string, unknown> => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new CapabilityError('invalid', 'The arguments must be an object.')
  }
  return args as Record<string, unknown>
}

function after(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return checkDocId(value)
}

export function dbCapability(data: ArtifactData): CapabilityHandler {
  const reach = (ctx: CapabilityContext) => ({ id: ctx.artifactId, project: null })
  return {
    name: 'db',
    consent: false,
    ops: OPS,
    async call(ctx, op, args) {
      const o = fields(args)
      switch (op) {
        case 'get':
          return data.get(PAGE_ACTOR, reach(ctx), checkCollection(o.collection), checkDocId(o.id))
        case 'set':
        case 'update': {
          const doc = await data.put(PAGE_ACTOR, reach(ctx), {
            collection: checkCollection(o.collection),
            docId: checkDocId(o.id),
            value: op === 'set' ? o.value : o.patch,
            merge: op === 'update',
            baseVersion: checkBase(o.baseVersion),
          })
          return { id: doc.id, version: doc.version }
        }
        case 'delete':
          return data.delete(
            PAGE_ACTOR,
            reach(ctx),
            checkCollection(o.collection),
            checkDocId(o.id),
            checkBase(o.baseVersion),
          )
        case 'list':
          return data.list(
            PAGE_ACTOR,
            reach(ctx),
            checkCollection(o.collection),
            after(o.after),
            checkLimit(o.limit),
          )
        case 'query':
          return data.query(
            PAGE_ACTOR,
            reach(ctx),
            checkCollection(o.collection),
            checkFilters(o.where),
            checkOrder(o.orderBy),
            checkLimit(o.limit),
          )
        case 'collections':
          return (await data.collections(PAGE_ACTOR, reach(ctx))).collections
        default:
          throw new CapabilityError('unsupported', `db.${op} streams; use watch.`)
      }
    },
    async stream(ctx, op, args, emit) {
      if (op !== 'watch') throw new CapabilityError('unsupported', `db.${op} does not stream.`)
      const o = fields(args)
      const collection = o.collection === undefined ? null : checkCollection(o.collection)
      if (ctx.signal.aborted) return
      await new Promise<void>((resolve) => {
        const stop = data.watch(PAGE_ACTOR, ctx.artifactId, collection, (change: DataChange) =>
          emit(change),
        )
        ctx.signal.addEventListener(
          'abort',
          () => {
            stop()
            resolve()
          },
          { once: true },
        )
      })
    },
  }
}
