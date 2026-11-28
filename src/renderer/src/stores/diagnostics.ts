import { create } from 'zustand'
import { DEBUG_OFF } from '@shared/debug'
import type { DiagnosticsStatus } from '@shared/remote/host-admin'
import { isWeb } from '@renderer/lib/platform'
import { useDebugStore } from './debug'
import { useReportStore } from './report'

export interface DiagnosticsStore {
  /** Current diagnostics state of this scope's host; null until loaded or on older hosts. */
  status: DiagnosticsStatus | null
}

function localDesktopStatus(): DiagnosticsStatus {
  return {
    recording: useReportStore.getState().recording,
    debug: useDebugStore.getState().status,
    canRecord: true,
    canClearVerbose: true,
    canRestartNormally: true,
  }
}

/**
 * Diagnostics state for the default scope: this desktop computer's live debug and recording
 * state, or the connected host's state in the web client.
 */
export const useLocalDiagnosticsStore = create<DiagnosticsStore>()(() => ({
  status: isWeb ? null : localDesktopStatus(),
}))

if (!isWeb) {
  const syncDesktop = (): void => {
    useLocalDiagnosticsStore.setState({ status: localDesktopStatus() })
  }
  useDebugStore.subscribe(syncDesktop)
  useReportStore.subscribe(syncDesktop)
}

/** Updates the web client's diagnostics, debug marker and recording pill together. */
export function receiveWebDiagnostics(status: DiagnosticsStatus | null): void {
  useLocalDiagnosticsStore.setState({ status })
  useDebugStore.setState({ status: status?.debug ?? DEBUG_OFF })
  useReportStore.setState({ recording: status?.recording ?? null })
}
