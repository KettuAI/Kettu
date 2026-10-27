import { create } from 'zustand'
import type { McpStatus } from '@shared/agent-host'
import { errorMessage, host } from '@renderer/lib/host'

interface McpStore {
  /** The last read of Settings › MCP servers; null until one answers. */
  status: McpStatus | null
  error: string | null
  /** True while a read runs, so the page can hold its skeleton until the first one. */
  reading: boolean
  load(): Promise<void>
  retry(): Promise<void>
}

let latest = 0

export const useMcpStore = create<McpStore>()((set) => ({
  status: null,
  error: null,
  reading: false,
  async load() {
    const read = ++latest
    set({ reading: true, error: null })
    try {
      const status = await host('mcp.status', undefined)
      if (read === latest) set({ status, reading: false })
    } catch (e) {
      if (read === latest) set({ error: errorMessage(e), reading: false })
    }
  },
  async retry() {
    const read = ++latest
    set({ reading: true, error: null })
    try {
      const status = await host('mcp.retry', undefined)
      if (read === latest) set({ status, reading: false })
    } catch (e) {
      if (read === latest) set({ error: errorMessage(e), reading: false })
    }
  },
}))

/** Reads the status once, when Settings opens; a failure shows on the page. */
export function loadMcpStatus(): void {
  void useMcpStore.getState().load()
}
