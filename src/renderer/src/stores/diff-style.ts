import { create } from 'zustand'
import { readJson, writeJson } from '@renderer/lib/storage'

// Whether diffs show one column or the old and new file side by side, kept on this device in
// localStorage and shared by every diff.

export type DiffStyle = 'unified' | 'split'

const KEY = 'diff-style'

export const useDiffStyle = create<{ style: DiffStyle }>(() => ({
  style: readJson<unknown>(KEY, 'unified') === 'split' ? 'split' : 'unified',
}))

export function setDiffStyle(style: DiffStyle): void {
  useDiffStyle.setState({ style })
  writeJson(KEY, style)
}
