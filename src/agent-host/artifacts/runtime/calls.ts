// What the page runtime keeps in the thread database beside the artifacts: each version's
// declaration, each artifact's data, and the user's consents; and the calls the host makes on them.

/** The capabilities a version declares and the runtime interface it was written for. */
export interface Declaration {
  capabilities: string[]
  runtime: number
}

/** An artifact's latest version as the runtime checks a page's request against it. */
export interface DeclaredArtifact extends Declaration {
  id: string
  project: string
  title: string
  head: number
  deleted: boolean
}

/** A document of an artifact's data. `version` grows with every write of the artifact's data. */
export interface DataDoc {
  collection: string
  id: string
  value: unknown
  version: number
  updatedAt: number
}

/** One filter of a query: a field, by its dotted path, compared to a value. */
export interface DataFilter {
  field: string
  op: '==' | '!=' | '<' | '<=' | '>' | '>='
  value: string | number | boolean | null
}

export interface DataOrder {
  field: string
  direction: 'asc' | 'desc'
}

/**
 * Where a call reaches, as for the artifacts: a session's project, or anywhere for null. An
 * artifact in Recently deleted keeps its data, which nobody reads or writes there.
 */
interface Reach {
  id: string
  project: string | null
}

export interface RuntimeCalls {
  /** The artifact with a version's declaration, the latest's when `version` is null. */
  declaration: {
    params: Reach & { version: number | null }
    result: DeclaredArtifact
  }
  dataGet: { params: Reach & { collection: string; docId: string }; result: DataDoc | null }
  /**
   * Writes a document, the whole of it (`set`) or merged into the object it holds (`merge`), from
   * `baseVersion` when given: 0 for a document that must not exist yet. Refused when it would
   * take the artifact's data past `limit` bytes.
   */
  dataPut: {
    params: Reach & {
      collection: string
      docId: string
      mode: 'set' | 'merge'
      json: string
      baseVersion: number | null
      docLimit: number
      limit: number
      at: number
    }
    result: DataDoc
  }
  dataDelete: {
    params: Reach & { collection: string; docId: string; baseVersion: number | null }
    result: { deleted: boolean }
  }
  /** A collection's documents by id, after `after` when given; `next` is the cursor of the rest. */
  dataList: {
    params: Reach & { collection: string; after: string | null; limit: number }
    result: { docs: DataDoc[]; next: string | null }
  }
  dataQuery: {
    params: Reach & {
      collection: string
      where: DataFilter[]
      orderBy: DataOrder | null
      limit: number
    }
    result: DataDoc[]
  }
  dataCollections: {
    params: Reach
    result: { collections: { name: string; count: number }[]; bytes: number }
  }
  /** The capabilities the user allowed the artifact. */
  consentOf: { params: { id: string }; result: string[] }
  consentGrant: { params: { id: string; capability: string; at: number }; result: null }
  /** Takes back every capability the user allowed the artifact. */
  consentRevoke: { params: { id: string }; result: { changed: boolean } }
  /** Every artifact outside Recently deleted the user allowed something, by title. */
  consents: {
    params: void
    result: { id: string; title: string; project: string; capabilities: string[] }[]
  }
}

export type RuntimeCallName = keyof RuntimeCalls

export type RuntimeCall = {
  [K in RuntimeCallName]: { name: K; params: RuntimeCalls[K]['params'] }
}[RuntimeCallName]
