// The canvas documents being worked on: each canvas artifact a client shows has one here, the
// latest version's `canvas.json` with the operations clients sent since. Operations apply in the
// order they arrive, the last one winning per property, and go to every client showing the
// artifact; a user's become a version once the canvas has been quiet a while, or when the last
// client closes it. Everything for one artifact runs in turn, so a version and an operation never
// interleave.

import {
  applyCanvasOps,
  CANVAS_FILE,
  CanvasError,
  parseCanvasDoc,
  stringifyCanvasDoc,
  type CanvasDoc,
  type CanvasOp,
} from '@shared/canvas-doc'
import { CANVAS_SPLIT_NOTE, type CanvasEvent, type CanvasState } from '@shared/artifact-canvas'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { splitLegacyCanvas } from '@shared/canvas-legacy'
import { HostError } from '../errors'
import type { LogFn } from '../storage'
import type { ArtifactStore, FoundVersion } from './store'

/** How long a canvas stays quiet before the user's operations become a version. */
export const CANVAS_QUIET_MS = 30_000

interface Live {
  /** The version `base` was read from. */
  version: number
  /** The document as that version holds it. */
  base: CanvasDoc
  /** The user's operations since, not yet in a version, in the order they applied. */
  pending: CanvasOp[]
  doc: CanvasDoc
  seq: number
  timer: ReturnType<typeof setTimeout> | null
}

export interface LiveCanvasDeps {
  log: LogFn
  /** The ports showing the artifact. */
  ports(id: string): Iterable<string>
  send(ports: Iterable<string>, event: CanvasEvent): void
  quietMs?: number
}

export class LiveCanvases {
  private readonly live = new Map<string, Live>()
  private readonly queue = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: ArtifactStore,
    private readonly deps: LiveCanvasDeps,
  ) {}

  /** Runs `work` after everything already queued for the artifact. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.queue.get(id) ?? Promise.resolve()
    const run = before.then(work, work)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queue.set(id, tail)
    void tail.then(() => {
      if (this.queue.get(id) === tail) this.queue.delete(id)
    })
    return run
  }

  private async docOf(found: FoundVersion): Promise<CanvasDoc | null> {
    const file = found.files.find((f) => f.path === CANVAS_FILE)
    if (!file) return null
    try {
      return parseCanvasDoc((await this.store.bytes(found, file)).toString('utf8'))
    } catch (error) {
      if (error instanceof CanvasError) {
        throw new HostError(
          'invalid_params',
          `${CANVAS_FILE} of ${found.artifact.id} is not valid: ${error.message}`,
        )
      }
      throw error
    }
  }

  /** The live document, read from the latest version when there is none or it is behind. */
  private async load(id: string): Promise<Live | null> {
    const found = await this.store.get(id)
    const current = this.live.get(id)
    if (current && current.version === found.artifact.head) return current
    const doc = await this.docOf(found)
    if (!doc) {
      if (current) this.drop(id)
      return null
    }
    // A version came from elsewhere: the user's pending operations go on top of it again.
    let pending: CanvasOp[] = []
    let next = doc
    if (current && current.pending.length > 0) {
      for (const op of current.pending) {
        try {
          next = applyCanvasOps(next, [op])
          pending.push(op)
        } catch {
          // An operation the new version made impossible is dropped.
        }
      }
    } else pending = []
    const live: Live = {
      version: found.artifact.head,
      base: doc,
      pending,
      doc: next,
      seq: (current?.seq ?? 0) + 1,
      timer: current?.timer ?? null,
    }
    this.live.set(id, live)
    return live
  }

  /**
   * What a client showing the canvas starts from. An old canvas, still one `index.html`, reports
   * `legacy` and no document until a change splits it.
   */
  state(id: string): Promise<CanvasState> {
    return this.serial(id, async () => {
      const live = await this.load(id)
      if (live) return { version: live.version, seq: live.seq, doc: live.doc, legacy: false }
      const found = await this.store.get(id)
      return {
        version: found.artifact.head,
        seq: 0,
        doc: null,
        legacy: found.files.some((f) => f.path === ARTIFACT_ENTRY) && found.version.pages >= 2,
      }
    })
  }

  /** Splits an old canvas into the canvas format as a new version, before its first change. */
  private async split(id: string): Promise<Live> {
    const found = await this.store.get(id)
    const entry = found.files.find((f) => f.path === ARTIFACT_ENTRY)
    const split = entry
      ? splitLegacyCanvas(
          (await this.store.bytes(found, entry)).toString('utf8'),
          new Set(found.files.map((f) => f.path)),
        )
      : null
    if (!split) throw new HostError('invalid_params', `${id} is not a canvas`)
    const changes = [
      ...[...split.files].map(([path, text]) => ({ path, data: Buffer.from(text, 'utf8') })),
      { path: CANVAS_FILE, data: Buffer.from(stringifyCanvasDoc(split.doc), 'utf8') },
      { path: ARTIFACT_ENTRY, data: null },
    ]
    const { version } = await this.store.write({
      id,
      baseVersion: found.artifact.head,
      changes,
      pages: split.doc.pages.length,
      author: null,
      note: CANVAS_SPLIT_NOTE,
    })
    this.deps.log('info', `Split ${id} into the canvas format as version ${version}`)
    const live = await this.load(id)
    if (!live) throw new HostError('internal', `${id} has no canvas document after its split`)
    this.deps.send(this.deps.ports(id), { id, seq: live.seq, doc: live.doc, version: live.version })
    return live
  }

  /**
   * Applies a client's operations as the user's: they show at once to every client, and become a
   * version once the canvas has been quiet. Returns the sequence number they took.
   */
  apply(
    id: string,
    ops: readonly CanvasOp[],
    client: string,
    clientSeq: number,
  ): Promise<{ seq: number }> {
    return this.serial(id, async () => {
      const live = (await this.load(id)) ?? (await this.split(id))
      let doc: CanvasDoc
      try {
        doc = applyCanvasOps(live.doc, ops)
      } catch (error) {
        if (error instanceof CanvasError) throw new HostError('invalid_params', error.message)
        throw error
      }
      live.doc = doc
      live.pending.push(...ops)
      live.seq++
      this.deps.send(this.deps.ports(id), { id, seq: live.seq, ops: [...ops], client, clientSeq })
      this.schedule(id, live)
      return { seq: live.seq }
    })
  }

  private schedule(id: string, live: Live): void {
    if (live.timer) clearTimeout(live.timer)
    live.timer = setTimeout(() => void this.flush(id), this.deps.quietMs ?? CANVAS_QUIET_MS)
    live.timer.unref?.()
  }

  /** Writes the user's pending operations as a version now. */
  flush(id: string): Promise<void> {
    return this.serial(id, () => this.flushNow(id))
  }

  private async flushNow(id: string): Promise<void> {
    const live = this.live.get(id)
    if (!live || live.pending.length === 0) return
    if (live.timer) clearTimeout(live.timer)
    live.timer = null
    try {
      const { version } = await this.store.write({
        id,
        baseVersion: live.version,
        changes: [{ path: CANVAS_FILE, data: Buffer.from(stringifyCanvasDoc(live.doc), 'utf8') }],
        unchecked: [CANVAS_FILE],
        pages: live.doc.pages.length,
        author: null,
        note: null,
      })
      live.version = version
      live.base = live.doc
      live.pending = []
    } catch (error) {
      this.deps.log(
        'warn',
        `The canvas changes of ${id} were not saved: ${(error as Error).message}`,
      )
    }
  }

  /**
   * An agent's write that carries canvas operations: the user's pending ones become their own
   * version first, so each version names its author, then the agent's apply to the latest
   * document, which `write` gets to put in its version beside its files.
   */
  agentWrite<T>(
    id: string,
    ops: readonly CanvasOp[],
    write: (canvas: { data: Buffer; pages: number } | null) => Promise<T>,
  ): Promise<T> {
    return this.serial(id, async () => {
      await this.flushNow(id)
      if (ops.length === 0) return write(null)
      const found = await this.store.get(id)
      let doc = await this.docOf(found)
      if (!doc) {
        await this.split(id)
        doc = (await this.load(id))?.doc ?? null
      }
      if (!doc) throw new HostError('invalid_params', `${id} is not a canvas`)
      let next: CanvasDoc
      try {
        next = applyCanvasOps(doc, ops)
      } catch (error) {
        if (error instanceof CanvasError) throw new HostError('invalid_params', error.message)
        throw error
      }
      return write({
        data: Buffer.from(stringifyCanvasDoc(next), 'utf8'),
        pages: next.pages.length,
      })
    })
  }

  /**
   * A new version reached the artifact: unless it is the one this module just saved, clients
   * showing the canvas get the document again, with the user's pending operations still on top.
   */
  versioned(id: string): void {
    if (!this.live.has(id)) return
    void this.serial(id, async () => {
      const before = this.live.get(id)?.version
      const live = await this.load(id).catch(() => null)
      if (!live || live.version === before) return
      this.deps.send(this.deps.ports(id), {
        id,
        seq: live.seq,
        doc: live.doc,
        version: live.version,
      })
    })
  }

  /** The last client stopped showing the artifact: its pending operations are saved. */
  closed(id: string): void {
    void this.serial(id, async () => {
      await this.flushNow(id)
      this.drop(id)
    })
  }

  private drop(id: string): void {
    const live = this.live.get(id)
    if (live?.timer) clearTimeout(live.timer)
    this.live.delete(id)
  }

  /** Saves every pending change, as the host stops. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.flush(id)))
  }
}
