// The SOPs a task may start with: the ones Kettu ships and the user's library, a folder of
// `<id>.yaml` files. An agent may write a library file, so one can start a task only while its
// text is the text the person approved; the approvals are kept in a file outside the folder.

import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { SOP_FILE_CHARS, type Sop, type SopSource, type SopSummary } from '@shared/tasks'
import { HostError, invalidParams, notFound } from '../errors'
import { JsonFile, writeFileAtomic, type LogFn } from '../storage'
import type { SopLibraryApi } from './api'
import { OFFICIAL_SOPS } from './official'
import { hashOf, isSopId, outlineOf, parseSop, SopProblem } from './sop'

export interface SopApproval {
  /** Who put the file in the library; null for a file Kettu did not write. */
  madeBy: 'agent' | 'user' | null
  /** The hash of the text the person approved; null for none. */
  approved: string | null
}

export interface SopApprovalsFile {
  version: 1
  sops: Record<string, SopApproval>
}

export interface SopLibraryDeps {
  /** The folder of the user's SOPs, one `<id>.yaml` each. */
  libraryDir: string
  /** The approvals file, outside `libraryDir`. */
  approvalsPath: string
  /** The host's language, for names an SOP gives by language. */
  language(): string
  /** Called after add, approve and remove. */
  changed(): void
  log: LogFn
}

const HASH = /^[0-9a-f]{64}$/
// A UTF-8 file of more bytes than this is longer than SOP_FILE_CHARS whatever it holds.
const SOP_FILE_BYTES = SOP_FILE_CHARS * 3

const SHIPPED = new Map(OFFICIAL_SOPS.map(({ file, text }) => [file.replace(/\.yaml$/, ''), text]))

/** Records that do not read are dropped alone, which leaves their SOPs pending. */
export function parseSopApprovals(data: Record<string, unknown>): SopApprovalsFile | string {
  const raw = data.sops
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '"sops" must be a mapping'
  }
  const sops: Record<string, SopApproval> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!isSopId(id) || typeof value !== 'object' || value === null) continue
    const { madeBy, approved } = value as Record<string, unknown>
    sops[id] = {
      madeBy: madeBy === 'agent' || madeBy === 'user' ? madeBy : null,
      approved: typeof approved === 'string' && HASH.test(approved) ? approved : null,
    }
  }
  return { version: 1, sops }
}

// An id may be the name of something every object has, such as "constructor".
function approvalOf(data: SopApprovalsFile, id: string): SopApproval | undefined {
  return Object.hasOwn(data.sops, id) ? data.sops[id] : undefined
}

type LibraryFile =
  | { kind: 'missing' }
  | { kind: 'broken'; hash: string; problem: string }
  | { kind: 'ok'; hash: string; sop: Sop }

function problemOf(error: unknown): string {
  if (error instanceof SopProblem) return error.message
  throw error
}

export function createSopLibrary(deps: SopLibraryDeps): SopLibraryApi {
  const approvalsFile = new JsonFile<SopApprovalsFile>({
    file: deps.approvalsPath,
    version: 1,
    migrations: {},
    parse: parseSopApprovals,
    empty: () => ({ version: 1, sops: {} }),
    log: deps.log,
  })
  let loading: Promise<SopApprovalsFile> | null = null

  function approvals(): Promise<SopApprovalsFile> {
    loading ??= approvalsFile.load().catch((error: unknown) => {
      loading = null
      throw error
    })
    return loading
  }

  async function saveApprovals(data: SopApprovalsFile): Promise<void> {
    approvalsFile.save(data)
    if (!(await approvalsFile.flushWritten())) {
      throw new Error('The SOP approvals could not be saved')
    }
  }

  // Callers pass only ids that passed isSopId, so the path stays inside the folder.
  function fileOf(id: string): string {
    return path.join(deps.libraryDir, `${id}.yaml`)
  }

  async function load(id: string): Promise<LibraryFile> {
    let text: string
    try {
      const info = await lstat(fileOf(id))
      if (!info.isFile()) return { kind: 'broken', hash: '', problem: 'it is not a plain file' }
      if (info.size > SOP_FILE_BYTES) {
        return {
          kind: 'broken',
          hash: '',
          problem: `the file is longer than ${SOP_FILE_CHARS} characters`,
        }
      }
      text = await readFile(fileOf(id), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
      return { kind: 'broken', hash: '', problem: `could not be read: ${(error as Error).message}` }
    }
    const hash = hashOf(text)
    let sop: Sop
    try {
      sop = parseSop(text, deps.language())
    } catch (error) {
      return { kind: 'broken', hash, problem: problemOf(error) }
    }
    if (sop.id !== id) {
      return {
        kind: 'broken',
        hash,
        problem: `the file is named "${id}.yaml" but its id is "${sop.id}"`,
      }
    }
    if (SHIPPED.has(id)) {
      return { kind: 'broken', hash, problem: `Kettu ships an SOP with the id "${id}"` }
    }
    return { kind: 'ok', hash, sop }
  }

  function summaryOf(
    id: string,
    file: Exclude<LibraryFile, { kind: 'missing' }>,
    approval: SopApproval | undefined,
  ): SopSummary {
    const madeBy = approval?.madeBy ?? null
    if (file.kind === 'broken') {
      return {
        source: 'library',
        id,
        name: id,
        description: '',
        hash: file.hash,
        outline: null,
        problem: file.problem,
        status: 'pending',
        madeBy,
      }
    }
    return {
      source: 'library',
      id,
      name: file.sop.name,
      description: file.sop.description,
      hash: file.hash,
      outline: outlineOf(file.sop),
      problem: null,
      status: approval?.approved === file.hash ? 'ready' : 'pending',
      madeBy,
    }
  }

  function shippedSummary(id: string, text: string): SopSummary {
    const base = { source: 'official', id, hash: hashOf(text), madeBy: null } as const
    try {
      const sop = parseSop(text, deps.language())
      return {
        ...base,
        name: sop.name,
        description: sop.description,
        outline: outlineOf(sop),
        problem: null,
        status: 'ready',
      }
    } catch (error) {
      return {
        ...base,
        name: id,
        description: '',
        outline: null,
        problem: problemOf(error),
        status: 'pending',
      }
    }
  }

  async function libraryIds(): Promise<string[]> {
    try {
      const entries = await readdir(deps.libraryDir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
        .map((entry) => entry.name.slice(0, -'.yaml'.length))
        .filter(isSopId)
        .sort()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }
  }

  return {
    async list() {
      const [ids, data] = await Promise.all([libraryIds(), approvals()])
      const files = await Promise.all(ids.map(async (id) => ({ id, file: await load(id) })))
      return [
        ...[...SHIPPED].map(([id, text]) => shippedSummary(id, text)),
        ...files.flatMap(({ id, file }) =>
          file.kind === 'missing' ? [] : [summaryOf(id, file, approvalOf(data, id))],
        ),
      ]
    },

    async read(source: SopSource, id: string) {
      if (source === 'official') {
        const text = SHIPPED.get(id)
        if (text === undefined) throw notFound(`Kettu ships no SOP "${id}"`)
        return { sop: parseSop(text, deps.language()), hash: hashOf(text) }
      }
      if (!isSopId(id)) throw notFound(`The library has no SOP "${id}"`)
      const file = await load(id)
      if (file.kind === 'missing') throw notFound(`The library has no SOP "${id}"`)
      if (file.kind === 'broken') {
        throw invalidParams(`The SOP "${id}" cannot be used: ${file.problem}`)
      }
      if (approvalOf(await approvals(), id)?.approved !== file.hash) {
        throw invalidParams(`The SOP "${id}" has not been approved as it is now`)
      }
      return { sop: file.sop, hash: file.hash }
    },

    async add(text: string, by: 'agent' | 'user') {
      let sop: Sop
      try {
        sop = parseSop(text, deps.language())
      } catch (error) {
        throw invalidParams(`The SOP is not valid: ${problemOf(error)}`)
      }
      const { id } = sop
      if (SHIPPED.has(id)) {
        throw invalidParams(`Kettu ships an SOP with the id "${id}"; choose another id`)
      }
      const data = await approvals()
      // An agent replaces only what an agent made, never a file of the person's.
      if (by === 'agent' && approvalOf(data, id)?.madeBy !== 'agent') {
        if ((await load(id)).kind !== 'missing') {
          throw invalidParams(`The library already has an SOP "${id}"; choose another id`)
        }
      }
      // The approval goes before the file is written, so no failure leaves new text approved.
      const approval: SopApproval = { madeBy: by, approved: null }
      data.sops[id] = approval
      await saveApprovals(data)
      await writeFileAtomic(fileOf(id), text)
      deps.changed()
      const file = await load(id)
      if (file.kind === 'missing') throw notFound(`The library has no SOP "${id}"`)
      return summaryOf(id, file, approval)
    },

    async approve(id: string, hash: string) {
      if (!isSopId(id)) throw notFound(`The library has no SOP "${id}"`)
      const file = await load(id)
      if (file.kind === 'missing') throw notFound(`The library has no SOP "${id}"`)
      if (file.kind === 'broken') {
        throw invalidParams(`The SOP "${id}" cannot be approved: ${file.problem}`)
      }
      if (file.hash !== hash) {
        throw new HostError('conflict', `The SOP "${id}" changed since it was shown`)
      }
      const data = await approvals()
      const approval: SopApproval = { madeBy: approvalOf(data, id)?.madeBy ?? null, approved: hash }
      data.sops[id] = approval
      await saveApprovals(data)
      deps.changed()
      return summaryOf(id, file, approval)
    },

    async remove(id: string) {
      if (!isSopId(id)) throw notFound(`The library has no SOP "${id}"`)
      await rm(fileOf(id), { force: true })
      const data = await approvals()
      if (Object.hasOwn(data.sops, id)) {
        delete data.sops[id]
        await saveApprovals(data)
      }
      deps.changed()
    },
  }
}
