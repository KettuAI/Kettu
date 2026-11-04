// What an artifact's page may ask of Kettu through `kettu.use`: the capabilities a version
// declares, the page runtime's wire format, and the consents the user gives. Shared by the host
// that answers, main and the web client that relay, and the clients that ask for consent.

/** The page runtime's interface, which a version records it was written for. */
export const RUNTIME_VERSION = 1
/** Every interface the host still answers. */
export const RUNTIME_VERSIONS: readonly number[] = [1]

/** The capabilities a version may declare. */
export const DECLARED_CAPABILITIES = ['db', 'files', 'sample'] as const
export type DeclaredCapability = (typeof DECLARED_CAPABILITIES)[number]

/** The capabilities the user allows per artifact, before a page may use them. */
export const CONSENT_CAPABILITIES = ['files', 'sample'] as const
export type ConsentCapability = (typeof CONSENT_CAPABILITIES)[number]

export function isConsentCapability(value: unknown): value is ConsentCapability {
  return (CONSENT_CAPABILITIES as readonly unknown[]).includes(value)
}

/**
 * Whether an artifact declaring these loads from its own origin alone: a page that reads what is
 * outside it could otherwise spell it out in a CDN URL.
 */
export function isStrictDeclaration(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => capability === 'files' || capability === 'sample')
}

/** The declaration as given, sorted and without repeats, or what is wrong with it. */
export function parseDeclaration(value: unknown): DeclaredCapability[] | { problem: string } {
  if (!Array.isArray(value) || value.length > DECLARED_CAPABILITIES.length * 2) {
    return { problem: `must be a list of ${DECLARED_CAPABILITIES.join(', ')}` }
  }
  const seen = new Set<DeclaredCapability>()
  for (const item of value) {
    if (!(DECLARED_CAPABILITIES as readonly unknown[]).includes(item)) {
      return {
        problem: `names ${JSON.stringify(item)}; a version may declare ${DECLARED_CAPABILITIES.join(', ')}`,
      }
    }
    seen.add(item as DeclaredCapability)
  }
  return DECLARED_CAPABILITIES.filter((capability) => seen.has(capability))
}

// The wire format.

/** The path of the runtime's requests on an artifact's own origin, in the desktop app. */
export const RUNTIME_PATH = '/_kettu/v1'

/** The most a page's message may be, as JSON: a document, or a question with its images. */
export const RUNTIME_MESSAGE_BYTES = 8 * 1024 * 1024

const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,64}$/
const CAPABILITY_NAME = /^[a-z][a-z0-9_]{0,31}$/
const OP_NAME = /^[a-z][A-Za-z0-9_]{0,31}$/

export type RuntimeErrorCode =
  | 'not_declared'
  | 'not_allowed'
  | 'unsupported'
  | 'invalid'
  | 'too_large'
  | 'rate_limited'
  | 'conflict'
  | 'not_found'
  | 'failed'

export interface RuntimeError {
  code: RuntimeErrorCode
  message: string
}

export type RuntimeMessage =
  | { v: number; id: string; kind: 'use'; cap: string }
  | { v: number; id: string; kind: 'call' | 'stream'; cap: string; op: string; args: unknown }
  | { v: number; id: string; kind: 'cancel' }

export type RuntimeAnswer =
  | { v: number; id: string; ok: true; value: unknown }
  | { v: number; id: string; ok: false; error: RuntimeError }
  | { v: number; id: string; event: unknown }
  | { v: number; id: string; done: true }

/** What `use` answers when the page may use a capability; null otherwise. */
export interface UseValue {
  ops: string[]
}

/** Whether a page's message is one capability code answers, not the editor's own kinds. */
export function isCapabilityKind(kind: unknown): boolean {
  return kind === 'use' || kind === 'call' || kind === 'stream' || kind === 'cancel'
}

/**
 * A page's message checked for shape, or null for one that is none. The version is any whole
 * number; whether it is still answered is the host's to say.
 */
export function parseRuntimeMessage(value: unknown): RuntimeMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { v, id, kind, cap, op, args } = value as Record<string, unknown>
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return null
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return null
  if (kind === 'cancel') return { v, id, kind }
  if (typeof cap !== 'string' || !CAPABILITY_NAME.test(cap)) return null
  if (kind === 'use') return { v, id, kind, cap }
  if (kind !== 'call' && kind !== 'stream') return null
  if (typeof op !== 'string' || !OP_NAME.test(op)) return null
  return { v, id, kind, cap, op, args: args ?? null }
}

/** The id and version an answer to an unreadable message can still carry. */
export function messageHeader(value: unknown): { v: number; id: string } {
  const { v, id } = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >
  return {
    v: typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : RUNTIME_VERSION,
    id: typeof id === 'string' && MESSAGE_ID.test(id) ? id : '',
  }
}

export function errorAnswer(
  header: { v: number; id: string },
  code: RuntimeErrorCode,
  message: string,
): RuntimeAnswer {
  return { v: header.v, id: header.id, ok: false, error: { code, message } }
}

/** Whether an answer ends its request: every one but a stream's event. */
export function isLastAnswer(answer: RuntimeAnswer): boolean {
  return !('event' in answer)
}

const ERROR_CODES: ReadonlySet<string> = new Set<RuntimeErrorCode>([
  'not_declared',
  'not_allowed',
  'unsupported',
  'invalid',
  'too_large',
  'rate_limited',
  'conflict',
  'not_found',
  'failed',
])

/** An answer from the host checked for shape, as main and the web client pass it on. */
export function isRuntimeAnswer(value: unknown): value is RuntimeAnswer {
  if (typeof value !== 'object' || value === null) return false
  const answer = value as Record<string, unknown>
  if (typeof answer.v !== 'number' || typeof answer.id !== 'string') return false
  if (answer.ok === true) return 'value' in answer
  if (answer.ok === false) {
    const error = answer.error as Record<string, unknown> | null
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof error.code === 'string' &&
      ERROR_CODES.has(error.code) &&
      typeof error.message === 'string'
    )
  }
  return 'event' in answer || answer.done === true
}

// Consent.

/** A consent the host asks a client for, outside the page, while the page waits. */
export interface ArtifactConsentAsk {
  requestId: string
  artifactId: string
  title: string
  /** The project's folder, which the prompt names by its last segment. */
  project: string
  capability: ConsentCapability
  /** For `sample`: the agent that answers the page's questions. */
  agent: string | null
}

/** An artifact the user allowed something, for Settings › Artifacts. */
export interface ArtifactConsentRow {
  artifactId: string
  title: string
  project: string
  capabilities: ConsentCapability[]
  /** The agent `sample` asks now, or null when there is none that can answer. */
  agent: string | null
}
