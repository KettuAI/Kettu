// The `content` capability: a type's viewer reads the content of the artifact it shows and writes
// the user's edits to it as the user's versions. Every artifact made from a type has it, and only
// those do, so the only page that can ask is the type's viewer, the one HTML page they serve.

import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { CONTENT_CAPABILITY, CONTENT_OPS, type ContentRead } from '@shared/artifact-runtime/content'
import {
  CapabilityError,
  registerCapability,
  type CapabilityContext,
  type CapabilityHandler,
} from '../runtime/dispatcher'
import { ArtifactError, type ArtifactStore } from '../store'
import { ContentError, type ArtifactTypes } from './registry'
import { ContentWriteError, writeContent } from './writes'

/** The text a write may carry, in UTF-16 units, before its bytes are counted. */
const MAX_TEXT = 6 * 1024 * 1024

export type ContentFailureCode = 'not_declared' | 'invalid' | 'too_large' | 'conflict' | 'not_found'

/** A refused request, with the runtime's code for its answer. */
export class ContentCapabilityError extends CapabilityError {
  declare readonly code: ContentFailureCode | 'unsupported'

  constructor(code: ContentFailureCode | 'unsupported', message: string) {
    super(code, message)
    this.name = 'ContentCapabilityError'
  }
}

export interface ContentCapabilityDeps {
  store: ArtifactStore
  types: ArtifactTypes
}

function version(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContentCapabilityError('invalid', `${name} must be a version number`)
  }
  return value as number
}

function fields(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ContentCapabilityError('invalid', 'The arguments must be an object')
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key))
      throw new ContentCapabilityError('invalid', `Unknown argument ${key}`)
  }
  return args as Record<string, unknown>
}

function refusal(error: unknown): unknown {
  if (error instanceof ArtifactError) {
    return new ContentCapabilityError(
      error.reason === 'not_found' ? 'not_found' : 'conflict',
      error.reason === 'deleted'
        ? 'The artifact is in Recently deleted'
        : error.reason === 'conflict'
          ? `The artifact is at version ${error.state?.version}`
          : 'No such artifact',
    )
  }
  if (error instanceof ContentError) {
    return new ContentCapabilityError('invalid', error.problems.join(' '))
  }
  if (error instanceof ContentWriteError) {
    return new ContentCapabilityError(error.code, error.message)
  }
  return error
}

export function contentCapability(deps: ContentCapabilityDeps): CapabilityHandler {
  const { store, types } = deps

  async function read(ctx: CapabilityContext, args: unknown): Promise<ContentRead> {
    const o = fields(args, ['version'])
    const wanted = o.version === undefined ? ctx.version : version(o.version, 'version')
    const found = await store.get(ctx.artifactId, { version: wanted })
    if (!found.type) throw new ContentCapabilityError('not_declared', 'Not made from a type')
    const entry = CONTENT_ENTRIES[found.type.name]
    const file = found.files.find((f) => f.path === entry)
    if (!file) throw new ContentCapabilityError('not_found', `The version has no ${entry}`)
    return {
      type: found.type.name,
      format: found.type.format,
      version: found.version.version,
      head: found.artifact.head,
      entry,
      text: (await store.bytes(found, file)).toString('utf8'),
      files: found.files.map((f) => ({ path: f.path, size: f.size })),
    }
  }

  async function write(ctx: CapabilityContext, args: unknown): Promise<{ version: number }> {
    const o = fields(args, ['baseVersion', 'text'])
    const baseVersion = version(o.baseVersion, 'baseVersion')
    if (typeof o.text !== 'string') throw new ContentCapabilityError('invalid', 'text must be text')
    if (o.text.length > MAX_TEXT) throw new ContentCapabilityError('too_large', 'text is too long')
    return writeContent(store, types, { id: ctx.artifactId, baseVersion, text: o.text })
  }

  return {
    name: CONTENT_CAPABILITY,
    // It reaches only the artifact's own content, which the user may change anyway.
    consent: false,
    ops: CONTENT_OPS,
    async call(ctx, op, args) {
      try {
        if (op === 'read') return await read(ctx, args)
        if (op === 'write') return await write(ctx, args)
        throw new ContentCapabilityError('unsupported', `content has no operation ${op}`)
      } catch (error) {
        throw refusal(error)
      }
    },
  }
}

export function registerContentCapability(deps: ContentCapabilityDeps): void {
  registerCapability(contentCapability(deps))
}
