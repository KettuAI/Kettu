import type { ProjectMcpDecision } from '@shared/thread'
import type { JsonFile, ProjectMcpFile } from './storage'

type FolderAnswers = ProjectMcpFile['folders'][string]

/**
 * The user's answers about the MCP servers a folder's own config declares, by the folder's path
 * key. A server nobody answered for is held like a refused one, so a repository cannot start a
 * program before the user agrees.
 */
export class ProjectMcpAnswers {
  private folders: ProjectMcpFile['folders'] = {}

  constructor(private readonly file: JsonFile<ProjectMcpFile>) {}

  async load(): Promise<void> {
    this.folders = (await this.file.load()).folders
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  /** Whether the server may start in the folder: null while nobody answered for it. */
  allowed(folder: string, name: string): boolean | null {
    const answers = this.of(folder)
    if (!answers) return null
    if (answers.skip.includes(name)) return false
    if (answers.all || answers.use.includes(name)) return true
    return null
  }

  /** Of `names`, those that may not start in the folder. */
  held(folder: string, names: readonly string[]): string[] {
    return names.filter((name) => this.allowed(folder, name) !== true)
  }

  answer(folder: string, names: readonly string[], decision: ProjectMcpDecision): void {
    const before = this.of(folder) ?? { use: [], skip: [] }
    const others = (list: readonly string[]) => list.filter((name) => !names.includes(name))
    const after: FolderAnswers =
      decision === 'skip'
        ? { ...before, use: others(before.use), skip: [...others(before.skip), ...names] }
        : {
            ...(decision === 'all' || before.all ? { all: true as const } : {}),
            use: [...others(before.use), ...names],
            skip: others(before.skip),
          }
    this.folders = { ...this.folders, [folder]: after }
    this.file.save({ version: 1, folders: this.folders })
  }

  private of(folder: string): FolderAnswers | undefined {
    return Object.hasOwn(this.folders, folder) ? this.folders[folder] : undefined
  }
}
