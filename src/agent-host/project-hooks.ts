import type { ProjectHooksDecision } from '@shared/thread'
import type { JsonFile, ProjectHooksAnswer, ProjectHooksFile } from './storage'

/**
 * The user's answers about what a folder's own settings make an agent's harness run or change, by
 * the folder's path key, then the harness, then a digest of those settings, so any change asks
 * again. Settings nobody answered for are held like refused ones, so a repository cannot run a
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

  /** Whether the folder's settings with this digest may apply: null while nobody answered. */
  allowed(folder: string, digest: string, harness = 'claude-code'): boolean | null {
    const answers = Object.hasOwn(this.folders, folder) ? this.folders[folder] : undefined
    const answer = answers && Object.hasOwn(answers, harness) ? answers[harness] : undefined
    if (!answer) return null
    if (answer.decision === 'all') return true
    if (!('digest' in answer)) return false
    return answer.digest === digest ? answer.decision === 'use' : null
  }

  answer(
    folder: string,
    digest: string,
    decision: ProjectHooksDecision,
    harness = 'claude-code',
  ): void {
    const answer: ProjectHooksAnswer = decision === 'all' ? { decision } : { decision, digest }
    const before = Object.hasOwn(this.folders, folder) ? this.folders[folder] : {}
    this.folders = { ...this.folders, [folder]: { ...before, [harness]: answer } }
    this.file.save({ version: 2, folders: this.folders })
  }
}
