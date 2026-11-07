import { app } from 'electron'
import type { UtilityHostEvent, UtilityHostState } from './utility-host'

export interface MainDiagnosticsSource {
  agentHost: { state: UtilityHostState; history(): UtilityHostEvent[] }
  terminalHost: { state: UtilityHostState; history(): UtilityHostEvent[] }
  launchToInteractiveMs: number | null
}

/** Main's own part of a problem report: versions, platform and the hosts' supervision. */
export function mainDiagnostics(source: MainDiagnosticsSource): Record<string, unknown> {
  return {
    app: { name: app.getName(), version: app.getVersion(), isPackaged: app.isPackaged },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    // Main's own, which the agent host's resolved environment shows better while it runs.
    environment: { PATH: process.env.PATH ?? null, SHELL: process.env.SHELL ?? null },
    launchToInteractiveMs: source.launchToInteractiveMs,
    agentHost: { state: source.agentHost.state, history: source.agentHost.history() },
    terminalHost: { state: source.terminalHost.state, history: source.terminalHost.history() },
  }
}
