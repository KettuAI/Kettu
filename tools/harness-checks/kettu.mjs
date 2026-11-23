// Kettu's own catalog, installers, version order and the connections of the preferred interfaces,
// loaded from the source through Vite's module runner, so a check installs, compares versions and
// talks to a harness exactly as the app does and reads whatever layout the catalog has.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build, runnerImport } from 'vite'

export const ROOT = path.resolve(import.meta.dirname, '../..')

const MODULES = {
  'src/agent-host/catalog.ts': ['buildCatalog'],
  'src/agent-host/adapter-install.ts': ['installAdapter'],
  'src/agent-host/archive-install.ts': ['installArchive', 'programPath'],
  'src/agent-host/find-command.ts': ['findCommand', 'isExecutableFile'],
  'src/agent-host/shell-env.ts': ['satisfiesNode'],
  'src/agent-host/versions.ts': ['compareVersions', 'versionAtLeast'],
  'src/agent-host/dsh/listing.ts': ['readListing', 'listingRows'],
  'src/agent-host/harness-versions.ts': ['BUNDLED'],
  'src/agent-host/opencode/connection.ts': ['OpenCodeConnection'],
  'src/agent-host/cline/connection.ts': ['ClineConnection'],
}

const ALIASES = [{ find: '@shared', replacement: path.join(ROOT, 'src/shared') }]

/** The modules above, as one object. */
export async function loadKettu() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-harness-modules-'))
  const entry = path.join(dir, 'kettu.ts')
  const lines = Object.entries(MODULES).map(([file, names]) => {
    const source = path.join(ROOT, file).split(path.sep).join('/')
    return `export { ${names.join(', ')} } from ${JSON.stringify(source)}`
  })
  await writeFile(entry, `${lines.join('\n')}\n`)
  try {
    const { module } = await runnerImport(entry, {
      root: ROOT,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: ALIASES },
    })
    return module
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A script of Kettu's own that the app builds into a bundle of its own and runs as a process, such
 * as the one that loads Cline's SDK, built into `outDir`; the path to the bundle.
 */
export async function bundle(file, outDir) {
  const name = `${path.basename(file, path.extname(file))}.cjs`
  await build({
    root: ROOT,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: ALIASES },
    ssr: { noExternal: true },
    build: {
      ssr: path.join(ROOT, file),
      outDir,
      emptyOutDir: true,
      minify: false,
      copyPublicDir: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: name } },
    },
  })
  return path.join(outDir, name)
}

/**
 * The npm range of a harness's versions that Kettu's mapping accepts: the update range where the
 * catalog gives one, else from its oldest version on, else any.
 */
export function rangeOf(def, kettu) {
  const { launch } = def
  if (typeof launch.updates === 'string') return launch.updates
  const oldest = oldestOf(def, kettu)
  return oldest ? `>=${oldest}` : '*'
}

/**
 * The oldest version the catalog names for a harness, else the version Kettu bundles for one the
 * Registry does not list, which is the oldest that runs; null when there is neither.
 */
export function oldestOf(def, kettu) {
  const named = [
    def.cli?.oldest,
    def.minimum,
    def.launch.minimum,
    def.installs?.archive?.minimum,
    kettu?.BUNDLED.kettu.get(def.id)?.version,
  ]
  return named.find((version) => typeof version === 'string') ?? null
}
