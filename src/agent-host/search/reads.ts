// What a thread worker answers about the search index: the sessions that hold the words of a
// search, and the text around them. The writer reads its own index; a reader opens the file
// read-only when it first needs it and opens it again if the writer made it anew.

import { statSync } from 'node:fs'
import type { ThreadDb } from '../threads/db'
import type { Indexer } from './indexer'
import {
  isIndexDamaged,
  type BuildProgress,
  type Candidate,
  type IndexLog,
  SearchIndex,
  type SessionMatch,
  type Snippet,
  type SnippetPick,
} from './index'

export interface SearchAnswer {
  candidates: Candidate[]
  /** The index is still being built, so the answer may be partial. */
  indexing: BuildProgress | null
}

export interface FindAnswer {
  matches: SessionMatch[]
  /** There are more matches than were kept, the oldest being left out. */
  capped: boolean
  indexing: BuildProgress | null
}

export class IndexReads {
  private opened: { index: SearchIndex; id: string } | null = null

  constructor(
    private readonly file: string,
    private readonly db: ThreadDb,
    private readonly log: IndexLog,
    /** The indexer of this worker when it is the writer, which owns the index. */
    private readonly indexer: Indexer | null,
  ) {}

  find(words: readonly string[]): SearchAnswer {
    const index = this.index()
    if (!index) return { candidates: [], indexing: this.unbuilt() }
    try {
      return { candidates: index.find(words), indexing: index.build() }
    } catch (error) {
      this.failed(error)
      return { candidates: [], indexing: this.unbuilt() }
    }
  }

  findIn(sessionId: string, words: readonly string[], limit: number): FindAnswer {
    const index = this.index()
    if (!index) return { matches: [], capped: false, indexing: this.unbuilt() }
    try {
      return { ...index.findIn(sessionId, words, limit), indexing: index.build() }
    } catch (error) {
      this.failed(error)
      return { matches: [], capped: false, indexing: this.unbuilt() }
    }
  }

  snippets(words: readonly string[], picks: readonly SnippetPick[]): Snippet[] {
    const index = this.index()
    if (!index || words.length === 0) return []
    try {
      return index.snippets(words, picks)
    } catch (error) {
      this.failed(error)
      return []
    }
  }

  close(): void {
    this.opened?.index.close()
    this.opened = null
  }

  /** Nothing is indexed yet, because the file is not there or not readable: all is still to do. */
  private unbuilt(): BuildProgress | null {
    const total = this.db.threadCount()
    return total > 0 ? { done: 0, total } : null
  }

  private failed(error: unknown): void {
    if (isIndexDamaged(error)) this.close()
    else throw error
  }

  private index(): SearchIndex | null {
    if (this.indexer) return this.indexer.current()
    let id: string
    try {
      const stat = statSync(this.file)
      id = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
    } catch {
      this.close()
      return null
    }
    if (this.opened?.id === id) return this.opened.index
    this.close()
    const index = SearchIndex.openReader(this.file, this.log)
    if (index) this.opened = { index, id }
    return index
  }
}
