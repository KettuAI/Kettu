import { useSyncExternalStore } from 'react'

type MarkdownModule = typeof import('./markdown-impl')

let loading: Promise<MarkdownModule> | null = null
let loaded: MarkdownModule['default'] | null = null
let settled = false
const listeners = new Set<() => void>()

/** Loads the Markdown renderer once; `Markdown` and the preload share this one import. */
export function loadMarkdown(): Promise<MarkdownModule> {
  loading ??= import('./markdown-impl').then(
    (module) => {
      loaded = module.default
      settle()
      return module
    },
    (error: unknown) => {
      // The thread still shows, with entries as plain text.
      console.error('The Markdown renderer failed to load:', error)
      settle()
      throw error
    },
  )
  return loading
}

function settle(): void {
  settled = true
  for (const listener of listeners) listener()
}

/** The renderer once it has loaded, so `Markdown` can skip the lazy boundary's first suspend. */
export function loadedMarkdown(): MarkdownModule['default'] | null {
  return loaded
}

/** Starts loading the Markdown renderer before the first entry needs it. */
export function preloadRenderers(): void {
  loadMarkdown().catch(() => {})
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the renderer has loaded or failed, so a thread never paints its raw Markdown first. */
export function useRenderersReady(): boolean {
  return useSyncExternalStore(subscribe, () => settled)
}
