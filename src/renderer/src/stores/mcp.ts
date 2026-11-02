import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { McpStatus } from '@shared/agent-host'
import { errorMessage, host, type HostRequest } from '@renderer/lib/host'

export interface McpStore {
  /** The last read of Settings › MCP servers; null until one answers. */
  status: McpStatus | null
  error: string | null
  /** True while a read runs, so the page can hold its skeleton until the first one. */
  reading: boolean
  load(): Promise<void>
  retry(): Promise<void>
}

export type McpStoreHook = UseBoundStore<StoreApi<McpStore>>

/** The MCP servers of the host `request` reaches: this computer's, or another host's. */
export function createMcpStore(request: HostRequest): McpStoreHook {
  let latest = 0
  const read = async (
    set: (state: Partial<McpStore>) => void,
    method: 'mcp.status' | 'mcp.retry',
  ): Promise<void> => {
    const id = ++latest
    set({ reading: true, error: null })
    try {
      const status = await request(method, undefined)
      if (id === latest) set({ status, reading: false })
    } catch (e) {
      if (id === latest) set({ error: errorMessage(e), reading: false })
    }
  }
  return create<McpStore>()((set) => ({
    status: null,
    error: null,
    reading: false,
    load: () => read(set, 'mcp.status'),
    retry: () => read(set, 'mcp.retry'),
  }))
}

export const useMcpStore = createMcpStore(host)

/** Reads the status once, when Settings opens; a failure shows on the page. */
export function loadMcpStatus(): void {
  void useMcpStore.getState().load()
}
