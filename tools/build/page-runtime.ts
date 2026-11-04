// A Vite plugin that bundles the artifact page runtime on its own, as one script for the server to
// put at the start of every HTML file it serves an artifact's frame, and gives the script's text
// as the module `virtual:kettu-page-runtime`.

import { build, type Plugin, type Rolldown } from 'vite'

const ID = 'virtual:kettu-page-runtime'
const RESOLVED = `\0${ID}`
/** The global the bundle assigns, which the served script keeps local. */
export const RUNTIME_GLOBAL = '__kettuRuntime'

/** `entry` is the runtime's module, which exports `start(config)`. */
export function pageRuntime(entry: string): Plugin {
  return {
    name: 'kettu:page-runtime',
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
          lib: { entry, formats: ['iife'], name: RUNTIME_GLOBAL },
        },
      })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[]
      const output = (Array.isArray(built) ? built[0]! : built).output[0]
      for (const module of output.moduleIds) {
        if (!module.startsWith('\0')) this.addWatchFile(module)
      }
      if (/<\/script/i.test(output.code)) throw new Error('The page runtime holds "</script"')
      return `export default ${JSON.stringify(output.code)}`
    },
  }
}
