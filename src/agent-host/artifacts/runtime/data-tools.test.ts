import { describe, expect, it, vi } from 'vitest'
import type { ArtifactData } from './data'
import { DataTools } from './data-tools'

const caller = { sessionId: 's1', project: '/project' }
const ARTIFACT_ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

function makeTools() {
  const data = {
    collections: vi.fn(async () => ({ collections: [], bytes: 0 })),
    get: vi.fn(async () => null),
    query: vi.fn(async () => []),
    list: vi.fn(async () => ({ docs: [], next: null })),
    put: vi.fn(async () => ({ version: 1 })),
    delete: vi.fn(async () => ({ deleted: true })),
  } as unknown as ArtifactData
  return { tools: new DataTools({ data }), data }
}

describe('DataTools strict-schema null optional arguments', () => {
  it('treats null optional fields as omitted on read_artifact_data', async () => {
    const { tools, data } = makeTools()
    const listedCollections = await tools.call(caller, 'read_artifact_data', {
      id: ARTIFACT_ID,
      collection: null,
      doc_id: null,
      where: null,
      order_by: null,
      after: null,
      limit: null,
    })
    expect(listedCollections.isError).toBeUndefined()
    expect(data.collections).toHaveBeenCalledOnce()

    const listedDocs = await tools.call(caller, 'read_artifact_data', {
      id: ARTIFACT_ID,
      collection: 'items',
      doc_id: null,
      where: null,
      order_by: null,
      after: null,
      limit: null,
    })
    expect(listedDocs.isError).toBeUndefined()
    expect(data.list).toHaveBeenCalledWith(
      { person: 'owner', session: 's1' },
      { id: ARTIFACT_ID, project: '/project' },
      'items',
      null,
      100,
    )
  })

  it('treats null patch/delete/base_version as omitted while preserving explicit JSON null value', async () => {
    const { tools, data } = makeTools()
    const writtenNull = await tools.call(caller, 'write_artifact_data', {
      id: ARTIFACT_ID,
      collection: 'items',
      doc_id: 'd1',
      value: null,
      patch: null,
      delete: null,
      base_version: null,
    })
    expect(writtenNull.isError).toBeUndefined()
    expect(data.put).toHaveBeenCalledWith(
      { person: 'owner', session: 's1' },
      { id: ARTIFACT_ID, project: '/project' },
      { collection: 'items', docId: 'd1', value: null, merge: false, baseVersion: null },
    )

    const patched = await tools.call(caller, 'write_artifact_data', {
      id: ARTIFACT_ID,
      collection: 'items',
      doc_id: 'd2',
      patch: { count: 1 },
      delete: null,
      base_version: null,
    })
    expect(patched.isError).toBeUndefined()
    expect(data.put).toHaveBeenLastCalledWith(
      { person: 'owner', session: 's1' },
      { id: ARTIFACT_ID, project: '/project' },
      { collection: 'items', docId: 'd2', value: { count: 1 }, merge: true, baseVersion: null },
    )
  })
})
