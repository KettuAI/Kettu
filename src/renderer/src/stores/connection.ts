import { create } from 'zustand'
import type { PortConnectionState } from '@shared/port-rpc'

interface ConnectionStore {
  agentHost: PortConnectionState
}

export const useConnectionStore = create<ConnectionStore>()(() => ({ agentHost: 'connected' }))
