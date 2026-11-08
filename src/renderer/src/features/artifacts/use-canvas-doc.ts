import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasState } from '@shared/artifact-canvas'
import {
  applyCanvasOps,
  type CanvasDoc,
  type CanvasObject,
  type CanvasOp,
} from '@shared/canvas-doc'
import { host } from '@renderer/lib/host'
import { useConnectionStore } from '@renderer/stores/connection'

/** How many of this client's changes undo can step back through. */
const UNDO_DEPTH = 200

interface Sent {
  seq: number
  ops: CanvasOp[]
}

interface Step {
  /** Undoes the step. */
  undo: CanvasOp[]
  /** Does it again. */
  redo: CanvasOp[]
}

/** Applies what still applies, skipping an operation the document no longer allows. */
function applyLoose(doc: CanvasDoc, ops: readonly CanvasOp[]): CanvasDoc {
  try {
    return applyCanvasOps(doc, ops)
  } catch {
    let next = doc
    for (const op of ops) {
      try {
        next = applyCanvasOps(next, [op])
      } catch {
        // Another client's change made it impossible.
      }
    }
    return next
  }
}

function objectOf(doc: CanvasDoc, id: string): CanvasObject | null {
  const canvas = doc.canvases.find((c) => c.id === id)
  if (canvas) return { type: 'canvas', ...canvas }
  const page = doc.pages.find((p) => p.id === id)
  if (page) return { type: 'page', ...page }
  const note = doc.notes.find((n) => n.id === id)
  return note ? ({ type: 'note', ...note } as CanvasObject) : null
}

/** What undoes `ops` on `doc`, in the order to apply it. */
export function inverseOps(doc: CanvasDoc, ops: readonly CanvasOp[]): CanvasOp[] {
  const out: CanvasOp[] = []
  let at = doc
  for (const op of ops) {
    switch (op.op) {
      case 'add':
        out.unshift({ op: 'remove', id: (op.object as { id: string }).id })
        break
      case 'set': {
        const found = objectOf(at, op.id) as Record<string, unknown> | null
        if (found) out.unshift({ op: 'set', id: op.id, key: op.key, value: found[op.key] ?? null })
        break
      }
      case 'remove': {
        const found = objectOf(at, op.id)
        if (!found) break
        const back: CanvasOp[] = [{ op: 'add', object: found }]
        const list = found.type === 'page' ? at.pages : found.type === 'note' ? at.notes : null
        const index = list?.findIndex((o) => o.id === op.id) ?? -1
        if (index >= 0) back.push({ op: 'order', id: op.id, index })
        // A page takes the arrows joined to it along.
        if (found.type === 'page') {
          for (const n of at.notes) {
            if ('from' in n && (n.from === op.id || n.to === op.id)) {
              if (n.from === op.id) back.push({ op: 'set', id: n.id, key: 'from', value: op.id })
              if (n.to === op.id) back.push({ op: 'set', id: n.id, key: 'to', value: op.id })
            }
          }
        }
        out.unshift(...back)
        break
      }
      case 'order': {
        const list = at.pages.some((p) => p.id === op.id) ? at.pages : at.notes
        const index = list.findIndex((o) => o.id === op.id)
        if (index >= 0) out.unshift({ op: 'order', id: op.id, index })
        break
      }
    }
    at = applyLoose(at, [op])
  }
  return out
}

/**
 * The live canvas document of an artifact, while `enabled`: the host's, with this client's
 * changes on top until the host has applied them. Changes show at once; undo and redo step through
 * this client's own.
 */
export function useCanvasDoc(id: string, enabled: boolean) {
  const connected = useConnectionStore((s) => s.agentHost === 'connected')
  const client = useMemo(() => `c${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, [])
  const [state, setState] = useState<CanvasState | null>(null)
  const confirmed = useRef<CanvasDoc | null>(null)
  const sent = useRef<Sent[]>([])
  const nextSeq = useRef(1)
  const [view, setView] = useState<CanvasDoc | null>(null)
  const undoStack = useRef<Step[]>([])
  const redoStack = useRef<Step[]>([])
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [failed, setFailed] = useState(false)

  const recompute = useCallback(() => {
    const base = confirmed.current
    setView(base ? sent.current.reduce((doc, s) => applyLoose(doc, s.ops), base) : null)
  }, [])

  useEffect(() => {
    if (!enabled || !connected) return
    let live = true
    host('artifacts.canvas', { id }).then(
      (next) => {
        if (!live) return
        confirmed.current = next.doc
        sent.current = []
        setState(next)
        recompute()
      },
      () => {
        if (live) setFailed(true)
      },
    )
    const off = window.kettu.agents.onEvent((event) => {
      if (event.type !== 'artifacts.canvas' || event.id !== id) return
      if (event.doc) {
        confirmed.current = event.doc
        setState((s) => ({
          version: event.version ?? s?.version ?? 0,
          seq: event.seq,
          doc: event.doc!,
          legacy: false,
        }))
      } else if (event.ops && confirmed.current) {
        confirmed.current = applyLoose(confirmed.current, event.ops)
        if (event.client === client) {
          sent.current = sent.current.filter((s) => s.seq !== event.clientSeq)
        }
      }
      recompute()
    })
    return () => {
      live = false
      off()
    }
  }, [id, enabled, connected, client, recompute])

  const send = useCallback(
    (ops: CanvasOp[]) => {
      if (ops.length === 0) return
      const seq = nextSeq.current++
      sent.current = [...sent.current, { seq, ops }]
      recompute()
      host('artifacts.canvasOps', { id, ops, client, clientSeq: seq }).catch((reason: unknown) => {
        console.error('A canvas change was refused', reason)
        sent.current = sent.current.filter((s) => s.seq !== seq)
        recompute()
      })
    },
    [id, client, recompute],
  )

  /** Applies a change of this client's, which undo can take back. */
  const apply = useCallback(
    (ops: CanvasOp[]) => {
      const doc = view
      if (!doc || ops.length === 0) return
      undoStack.current = [
        ...undoStack.current.slice(-UNDO_DEPTH + 1),
        { undo: inverseOps(doc, ops), redo: ops },
      ]
      redoStack.current = []
      setHistory({ undo: undoStack.current.length, redo: redoStack.current.length })
      send(ops)
    },
    [view, send],
  )

  /** Shows a change at once without sending it, such as a drag under way; `apply` sends the last. */
  const [preview, setPreview] = useState<CanvasOp[] | null>(null)

  const undo = useCallback(() => {
    const step = undoStack.current.at(-1)
    if (!step) return
    undoStack.current = undoStack.current.slice(0, -1)
    redoStack.current = [...redoStack.current, step]
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length })
    send(step.undo)
  }, [send])

  const redo = useCallback(() => {
    const step = redoStack.current.at(-1)
    if (!step) return
    redoStack.current = redoStack.current.slice(0, -1)
    undoStack.current = [...undoStack.current, step]
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length })
    send(step.redo)
  }, [send])

  const shown = useMemo(() => (view && preview ? applyLoose(view, preview) : view), [view, preview])

  return {
    doc: shown,
    /** The document without a preview under way, which changes start from. */
    base: view,
    legacy: state?.legacy ?? false,
    version: state?.version ?? null,
    failed,
    apply,
    preview: setPreview,
    undo,
    redo,
    canUndo: history.undo > 0,
    canRedo: history.redo > 0,
    /** Splits an old canvas into the canvas format, with a first change. */
    start: send,
  }
}

export type CanvasDocState = ReturnType<typeof useCanvasDoc>

/** An earlier version's document, shown as it is: nothing changes it. */
export function staticCanvas(doc: CanvasDoc): CanvasDocState {
  const none = (): void => {}
  return {
    doc,
    base: doc,
    legacy: false,
    version: null,
    failed: false,
    apply: none,
    preview: none,
    undo: none,
    redo: none,
    canUndo: false,
    canRedo: false,
    start: none,
  }
}
