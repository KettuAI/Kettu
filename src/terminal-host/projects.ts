import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Platform } from '@shared/platform'

export type Canonicalize = (path: string) => Promise<string>

const nativeRealpath: Canonicalize = (path) => realpath(path)

/** How two canonical paths compare: case-insensitively on Windows, as they are on its volumes. */
export function pathKey(canonical: string, platform: Platform): string {
  return platform === 'win32' ? canonical.toLowerCase() : canonical
}

export interface ProjectMatch {
  projectPath: string // the path as the agent host knows it
  cwd: string // canonical, for the shell
}

/**
 * The project folders a terminal may open in, from the list the agent host keeps. Paths are
 * compared after `path.resolve` and `realpath`, never as raw strings.
 */
export class ProjectRegistry {
  private known: Promise<Map<string, ProjectMatch>> = Promise.resolve(new Map())

  constructor(
    private readonly platform: Platform,
    private readonly canonicalize: Canonicalize = nativeRealpath,
  ) {}

  set(paths: string[]): void {
    const resolve = this.platform === 'win32' ? win32.resolve : posix.resolve
    this.known = Promise.all(
      paths.map(async (projectPath) => {
        try {
          const cwd = await this.canonicalize(resolve(projectPath))
          return [pathKey(cwd, this.platform), { projectPath, cwd }] as const
        } catch {
          return null // a missing folder cannot host a terminal
        }
      }),
    ).then((entries) => new Map(entries.filter((entry) => entry !== null)))
  }

  /** The known project a path names, or null when it is not one or no longer exists. */
  async match(path: string): Promise<ProjectMatch | null> {
    const isAbsolute = this.platform === 'win32' ? win32.isAbsolute : posix.isAbsolute
    if (!isAbsolute(path)) return null
    const resolve = this.platform === 'win32' ? win32.resolve : posix.resolve
    let canonical: string
    try {
      canonical = await this.canonicalize(resolve(path))
    } catch {
      return null
    }
    return (await this.known).get(pathKey(canonical, this.platform)) ?? null
  }
}
