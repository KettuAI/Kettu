// The page side of `kettu.use`: the frozen namespace a page gets for a capability, built from the
// ops the host answered. It runs inside the artifact's page, so it imports nothing at runtime.

import type { RuntimeError } from '../artifact-capabilities'
import { CONTENT_CAPABILITY, contentNamespace } from './content'

/**
 * How a namespace reaches the host. `call` resolves with the answer's value, or rejects with its
 * error (an object with `code` and `message`). `stream` passes each event to `onEvent`, then calls
 * `onEnd` once: with null when the host is done, with the error otherwise; it returns the cancel.
 */
export interface CapabilityTransport {
  call(cap: string, op: string, args: unknown): Promise<unknown>
  stream(
    cap: string,
    op: string,
    args: unknown,
    onEvent: (event: unknown) => void,
    onEnd?: (error: RuntimeError | null) => void,
  ): () => void
}

type Namespace = Readonly<Record<string, (...args: never[]) => unknown>>
type Builder = (ops: ReadonlySet<string>, transport: CapabilityTransport) => Namespace

const fail = (code: RuntimeError['code'], message: string): RuntimeError => ({ code, message })

const options = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** Only the ops the host answered, so a namespace offers nothing it would refuse. */
function only(ops: ReadonlySet<string>, all: Record<string, unknown>): Namespace {
  const kept: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(all)) if (ops.has(name)) kept[name] = fn
  return Object.freeze(kept) as Namespace
}

function db(ops: ReadonlySet<string>, transport: CapabilityTransport): Namespace {
  const call = (op: string, args: Record<string, unknown>) => transport.call('db', op, args)
  const base = (value: unknown) => {
    const baseVersion = options(value).baseVersion
    return baseVersion === undefined ? {} : { baseVersion }
  }
  return only(ops, {
    get: (collection: string, id: string) => call('get', { collection, id }),
    set: (collection: string, id: string, value: unknown, opts?: unknown) =>
      call('set', { collection, id, value, ...base(opts) }),
    update: (collection: string, id: string, patch: unknown, opts?: unknown) =>
      call('update', { collection, id, patch, ...base(opts) }),
    delete: (collection: string, id: string, opts?: unknown) =>
      call('delete', { collection, id, ...base(opts) }),
    list: (collection: string, opts?: unknown) => {
      const { after, limit } = options(opts)
      return call('list', { collection, after, limit })
    },
    query: (collection: string, opts?: unknown) => {
      const { where, orderBy, limit } = options(opts)
      return call('query', { collection, where, orderBy, limit })
    },
    collections: () => call('collections', {}),
    watch: (collection: unknown, onChange?: unknown) => {
      // watch(onChange) follows every collection, watch(name, onChange) one.
      const listener = typeof collection === 'function' ? collection : onChange
      if (typeof listener !== 'function') throw new TypeError('watch needs a function to call')
      const args = typeof collection === 'string' ? { collection } : {}
      return transport.stream('db', 'watch', args, (event) => listener(event))
    },
  })
}

function files(ops: ReadonlySet<string>, transport: CapabilityTransport): Namespace {
  return only(ops, {
    list: (path?: string) => transport.call('files', 'list', { path: path ?? '' }),
    read: async (path: string, opts?: unknown) => {
      const bytes = options(opts).as === 'bytes'
      const value = (await transport.call('files', 'read', {
        path,
        as: bytes ? 'base64' : 'text',
      })) as { text?: string; base64?: string }
      if (!bytes) return value.text
      const raw = atob(value.base64 ?? '')
      const out = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
      return out
    },
  })
}

function sample(ops: ReadonlySet<string>, transport: CapabilityTransport): Namespace {
  return only(ops, {
    // Resolves with the whole answer, text or the parsed JSON; onText gets the text as it comes.
    ask: (prompt: string, opts?: unknown) => {
      const { format, images, onText, signal } = options(opts)
      return new Promise((resolve, reject) => {
        let answered = false
        let answer: unknown = null
        const cancel = transport.stream(
          'sample',
          'ask',
          { prompt, format, images },
          (event) => {
            const e = options(event)
            if (e.type === 'text' && typeof e.text === 'string' && typeof onText === 'function') {
              onText(e.text)
            } else if (e.type === 'answer') {
              answered = true
              answer = format === 'json' ? e.json : e.text
            }
          },
          (error) => {
            if (error) reject(error)
            else if (answered) resolve(answer)
            else reject(fail('failed', 'The agent gave no answer.'))
          },
        )
        if (signal instanceof AbortSignal) {
          const stop = (): void => {
            cancel()
            reject(fail('failed', 'The question was cancelled.'))
          }
          if (signal.aborted) stop()
          else signal.addEventListener('abort', stop)
        }
      })
    },
  })
}

const BUILDERS: Readonly<Record<string, Builder>> = { db, files, sample }

/** The namespace `kettu.use(cap)` gives the page, or null for a capability it does not know. */
export function capabilityNamespace(
  cap: string,
  ops: readonly string[],
  transport: CapabilityTransport,
): object | null {
  if (cap === CONTENT_CAPABILITY) return contentNamespace(ops, transport)
  const build = Object.hasOwn(BUILDERS, cap) ? BUILDERS[cap] : undefined
  return build ? build(new Set(ops), transport) : null
}
