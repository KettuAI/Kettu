import { create } from 'zustand'
import type { SignInEndPhase } from '@shared/sign-in-end'
import { readJson, writeJson } from '@renderer/lib/storage'

// The sign-in end notices this device dismissed, in localStorage, each for one agent's sign-in by
// its date and for one phase: a new sign-in has another date, and once the date passes the notice
// that it probably ended shows again.

const KEY = 'kettu.sign-in-end-dismissed'

/** How many dismissals are kept; the oldest is forgotten past it. */
const MAX_KEPT = 50

function load(): string[] {
  const kept = readJson<unknown>(KEY, [])
  return Array.isArray(kept) ? kept.filter((entry) => typeof entry === 'string') : []
}

export const useSignInEndNotice = create<{ dismissed: string[] }>()(() => ({ dismissed: load() }))

export const dismissalOf = (agentId: string, ends: number, phase: SignInEndPhase): string =>
  `${agentId} ${ends} ${phase}`

export function dismissSignInEnd(agentId: string, ends: number, phase: SignInEndPhase): void {
  const entry = dismissalOf(agentId, ends, phase)
  const kept = useSignInEndNotice.getState().dismissed.filter((other) => other !== entry)
  const next = [...kept, entry].slice(-MAX_KEPT)
  useSignInEndNotice.setState({ dismissed: next })
  writeJson(KEY, next)
}
