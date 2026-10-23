import { host } from '@renderer/lib/host'
import { openArtifact } from '@renderer/stores/view'

/**
 * Development only, until the Artifacts page links to the viewer: `__overbenchDev.openArtifact()`
 * in DevTools shows the newest artifact, or the one whose id it is given.
 */
export function installArtifactDevTools(): void {
  Object.assign(window, {
    __overbenchDev: {
      openArtifact: async (id?: string): Promise<string | null> => {
        const target = id ?? (await host('artifacts.list', {}))[0]?.id ?? null
        if (target) openArtifact(target)
        return target
      },
    },
  })
}
