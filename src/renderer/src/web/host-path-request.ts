// Requests for a folder or a program on a host this window reaches over the channel, which the
// picker answers: the web client's host, or another host in the desktop app. Kept apart from the
// picker so an API can ask before the picker's code has loaded.

import { create } from 'zustand'
import type { Platform } from '@shared/platform'
import type { HostPathKind } from './host-path'

/** What the picker is for, which names it and decides whether it takes folders or programs. */
export type HostPathPurpose = 'project' | 'agentFolder' | 'shell' | 'agentProgram'

export const PATH_KINDS: Record<HostPathPurpose, HostPathKind> = {
  project: 'folder',
  agentFolder: 'folder',
  shell: 'program',
  agentProgram: 'program',
}

export interface HostPathRequest {
  purpose: HostPathPurpose
  /** The text the field starts with. */
  initial: string
  /**
   * Hands the chosen path to the host, as setting a program there does; a failure keeps the
   * picker open with the host's reason.
   */
  commit?: (path: string) => Promise<void>
  /** Another host the desktop app connects to, in place of the web client's own. */
  on?: { hostId: string; name: string; platform: Platform }
}

export interface AskedPath extends HostPathRequest {
  id: number
  resolve: (path: string | null) => void
}

export const usePathRequest = create<{ asked: AskedPath | null }>()(() => ({ asked: null }))

let nextId = 1

/** Shows the picker; the chosen path, or null when it was closed. */
export function askHostPath(request: HostPathRequest): Promise<string | null> {
  return new Promise((resolve) => {
    // A second request takes the place of one still open, which ends unanswered.
    usePathRequest.getState().asked?.resolve(null)
    usePathRequest.setState({ asked: { ...request, id: nextId++, resolve } })
  })
}

/** Ends the open request with the chosen path, or null when the picker closed. */
export function answerHostPath(path: string | null): void {
  const { asked } = usePathRequest.getState()
  if (!asked) return
  usePathRequest.setState({ asked: null })
  asked.resolve(path)
}
