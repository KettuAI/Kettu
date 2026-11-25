// Bundles the sandbox virtual filesystem bootstrap shim as an IIFE string for `virtual:kettu-sandbox-shim`.

import { build, type Plugin, type Rolldown } from 'vite'

const ID = 'virtual:kettu-sandbox-shim'
const RESOLVED = `\0${ID}`
/** Temporary global exposed by the bundled shim and deleted right after execution. */
export const SANDBOX_SHIM_GLOBAL = '__kettuSandboxShim'

/** `entry` exports `start(config)` for the sandbox bootstrap module. */
export function sandboxShim(entry: string): Plugin {
  return {
    name: 'kettu:sandbox-shim',
    resolveId(id) {
      return id === ID ? RESOLVED : null
    },
    async load(id) {
      if (id !== RESOLVED) return null
      const built = (await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        build: {
          write: false,
          minify: true,
          target: 'es2022',
          lib: { entry, formats: ['iife'], name: SANDBOX_SHIM_GLOBAL },
        },
      })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[]
      const output = (Array.isArray(built) ? built[0]! : built).output[0]
      for (const module of output.moduleIds) {
        if (!module.startsWith('\0')) this.addWatchFile(module)
      }
      if (/<\/script/i.test(output.code)) throw new Error('The sandbox shim holds "</script"')
      return `export default ${JSON.stringify(output.code)}`
    },
  }
}
