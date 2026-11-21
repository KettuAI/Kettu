import { create } from 'zustand'
import type { PillPlace } from '@shared/control'
import { readJson, writeJson } from '@renderer/lib/storage'

// Where the user put the pill that says who has a surface, kept per kind of surface on this
// device in localStorage, so the next tab of a kind shows it there. Null leaves it at the
// bottom, centred. Each kind has its own key: the browser's pill is drawn by another page, which
// must not write over the others.

export type PillKind = 'terminal' | 'browser' | 'device' | 'computer'

const KINDS: PillKind[] = ['terminal', 'browser', 'device', 'computer']

const key = (kind: PillKind) => `surface-pill-${kind}`

function load(kind: PillKind): PillPlace | null {
  const stored = readJson<Partial<PillPlace> | null>(key(kind), null)
  const share = (value: unknown): value is number =>
    typeof value === 'number' && value >= 0 && value <= 1
  return stored && share(stored.x) && share(stored.y) ? { x: stored.x, y: stored.y } : null
}

export const useSurfacePill = create<Record<PillKind, PillPlace | null>>(
  () =>
    Object.fromEntries(KINDS.map((kind) => [kind, load(kind)])) as Record<
      PillKind,
      PillPlace | null
    >,
)

/** Remembers where the pill of `kind` lies. */
export function setSurfacePill(kind: PillKind, at: PillPlace): void {
  useSurfacePill.setState({ [kind]: at })
  writeJson(key(kind), at)
}
