import { create } from 'zustand'
import type { Platform } from '@shared/platform'
import type { HostInfo } from '@shared/remote/host-admin'
import type { HostConnection } from '@shared/remote/hosts'
import type { DirectAddress } from '@shared/remote/protocol'

// The host the web client connects to, the one that served its page, as Settings shows it. The web
// client's entry keeps it up to date; the desktop app has none. Loaded before `window.kettu` is
// set, so it reads nothing from it as it loads.

export interface WebHost {
  name: string
  /** As the last welcome said; null before the first one. */
  platform: Platform | null
  version: string | null
  /** The page's own address, which this browser reaches the host at. */
  address: DirectAddress
  connection: HostConnection
  /** When the connection last opened or ended; null before either. */
  lastOnlineAt: number | null
  /** This browser on the host: its id there once welcomed, and the name the host lists it by. */
  device: { id: string | null; name: string }
}

/** What this browser can do about the host, which the web client's entry provides. */
export interface WebHostActions {
  /** Asks the host to list this browser under `name`; the host's answer renames it here. */
  rename(name: string): void
  /** Clears what this browser keeps for the host and goes back to pairing. */
  forget(): Promise<void>
}

interface WebHostStore {
  host: WebHost | null
  /** The host's facts and what it offers beyond its sessions, read at each connection. */
  info: HostInfo | null
  actions: WebHostActions | null
}

export const useWebHostStore = create<WebHostStore>()(() => ({
  host: null,
  info: null,
  actions: null,
}))
