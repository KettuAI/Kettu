import type { ProjectMcpDecision } from '@shared/thread'
import type { JsonFile, ProjectMcpFile, ProjectMcpFolder } from './storage'

/** A server a folder declares, as its answer is kept: by name and by a digest of its content. */
export interface AnsweredServer {
  name: string
  digest: string
  /** The digest of its names alone, which an earlier version kept answers by. */
  namesDigest?: string
}

/**
 * The user's answers about the MCP servers a folder's own config declares, by the folder's path
 * key and each server's content digest, so a changed command, argument, URL, variable or header,
 * value included, asks again. A server nobody answered for is held like a refused one, so a
 * repository cannot start a program before the user agrees.
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
  allowed(folder: string, server: AnsweredServer): boolean | null {
    const answers = this.of(folder)
    if (!answers) return null
    if (Object.hasOwn(answers.servers, server.digest)) {
      if (answers.servers[server.digest] === false) return false
    } else {
      const kept = this.takeOver(folder, answers, server)
      if (kept !== null) return kept
    }
    if (answers.all) return true
    return Object.hasOwn(answers.servers, server.digest) ? answers.servers[server.digest]! : null
  }

  /**
   * An answer an older version kept, by the server's names alone or by its name, stands for the
   * server as it is now and is kept by its digest from then on.
   */
  private takeOver(
    folder: string,
    answers: ProjectMcpFolder,
    server: AnsweredServer,
  ): boolean | null {
    const earlier = answers.earlier ?? {}
    if (server.namesDigest !== undefined && Object.hasOwn(earlier, server.namesDigest)) {
      const kept = earlier[server.namesDigest]!
      const rest = Object.fromEntries(
        Object.entries(earlier).filter(([digest]) => digest !== server.namesDigest),
      )
      this.set(folder, {
        ...answers,
        servers: { ...answers.servers, [server.digest]: kept },
        earlier: Object.keys(rest).length > 0 ? rest : undefined,
      })
      return kept
    }
    if (!answers.named) return null
    const { use, skip } = answers.named
    const kept = skip.includes(server.name) ? false : use.includes(server.name) ? true : null
    if (kept === null) return null
    const without = (list: string[]) => list.filter((name) => name !== server.name)
    const named = { use: without(use), skip: without(skip) }
    this.set(folder, {
      ...answers,
      servers: { ...answers.servers, [server.digest]: kept },
      named: named.use.length > 0 || named.skip.length > 0 ? named : undefined,
    })
    return kept
  }

  /** Of `servers`, those that may not start in the folder. */
  held<T extends AnsweredServer>(folder: string, servers: readonly T[]): T[] {
    return servers.filter((server) => this.allowed(folder, server) !== true)
  }

  answer(folder: string, servers: readonly AnsweredServer[], decision: ProjectMcpDecision): void {
    const before = this.of(folder) ?? { servers: {} }
    const allowed = decision !== 'skip'
    const after: ProjectMcpFolder = {
      ...before,
      ...(decision === 'all' || before.all ? { all: true as const } : {}),
      servers: {
        ...before.servers,
        ...Object.fromEntries(servers.map((server) => [server.digest, allowed])),
      },
    }
    this.set(folder, after)
  }

  private set(folder: string, answers: ProjectMcpFolder): void {
    if (answers.named === undefined) delete answers.named
    if (answers.earlier === undefined) delete answers.earlier
    this.folders = { ...this.folders, [folder]: answers }
    this.file.save({ version: 3, folders: this.folders })
  }

  private of(folder: string): ProjectMcpFolder | undefined {
    return Object.hasOwn(this.folders, folder) ? this.folders[folder] : undefined
  }
}
