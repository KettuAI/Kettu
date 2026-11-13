import type { ProjectHooksDecision } from '@shared/thread'
import type { JsonFile, ProjectHooksFile } from './storage'

/**
 * The user's answers about the hooks a folder's own Claude Code settings declare, by the folder's
 * path key. Hooks nobody answered for are held like refused ones, so a repository cannot run a
 * command before the user agrees.
 */
export class ProjectHooksAnswers {
  private folders: ProjectHooksFile['folders'] = {}

  constructor(private readonly file: JsonFile<ProjectHooksFile>) {}

  async load(): Promise<void> {
    this.folders = (await this.file.load()).folders
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  /** Whether the folder's hooks with this digest may run: null while nobody answered for them. */
  allowed(folder: string, digest: string): boolean | null {
    const answer = Object.hasOwn(this.folders, folder) ? this.folders[folder] : undefined
    if (!answer) return null
    if (answer.decision === 'use') return answer.digest === digest ? true : null
    return answer.decision === 'all'
  }

  answer(folder: string, digest: string, decision: ProjectHooksDecision): void {
    const answer = decision === 'use' ? { decision, digest } : { decision }
    this.folders = { ...this.folders, [folder]: answer }
    this.file.save({ version: 1, folders: this.folders })
  }
}
