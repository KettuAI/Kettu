import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactImportResult, ArtifactSummary } from '@shared/artifacts'

const request = vi.fn()
const importFile = vi.fn<(project: string | null) => Promise<ArtifactImportResult>>()
vi.stubGlobal('window', { overbench: { agents: { request }, artifacts: { import: importFile } } })

const { artifactsChanged, artifactListShown, importArtifact, retryArtifacts, useArtifactsStore } =
  await import('./artifacts')

const listed = (title: string) => [{ id: 'art_1', title } as ArtifactSummary]
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The host's answers: the list for `artifacts.list`, and `deleted` for Recently deleted. */
function answer(list: ArtifactSummary[], deleted: ArtifactSummary[] = []): void {
  request.mockImplementation((_method: string, params: { deleted?: boolean }) =>
    Promise.resolve(params.deleted ? deleted : list),
  )
}

describe('artifacts store', () => {
  beforeEach(() => {
    request.mockReset()
    importFile.mockReset()
    useArtifactsStore.setState({
      list: null,
      deleted: null,
      error: null,
      filter: '',
      opened: null,
      importFailed: null,
    })
  })

  it('reads both lists when a view shows, then follows changes only while one shows', async () => {
    answer(listed('One'), listed('Gone'))
    artifactListShown(true)
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith('artifacts.list', {})
    expect(request).toHaveBeenCalledWith('artifacts.list', { deleted: true })
    expect(useArtifactsStore.getState()).toMatchObject({
      list: listed('One'),
      deleted: listed('Gone'),
    })

    artifactListShown(false)
    artifactListShown(true)
    await flush()
    expect(request).toHaveBeenCalledTimes(2)

    artifactListShown(false)
    artifactsChanged()
    expect(request).toHaveBeenCalledTimes(2)
    answer(listed('Two'))
    artifactListShown(true)
    await flush()
    expect(request).toHaveBeenCalledTimes(4)
    expect(useArtifactsStore.getState().list).toEqual(listed('Two'))
    artifactListShown(false)
  })

  it('reads once more for changes that arrive while a read runs', async () => {
    const answers: ((list: ArtifactSummary[]) => void)[] = []
    request.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    artifactListShown(true)
    artifactsChanged()
    artifactsChanged()
    expect(request).toHaveBeenCalledTimes(2)
    answers[0]!(listed('Old'))
    answers[1]!([])
    await flush()
    expect(request).toHaveBeenCalledTimes(4)
    answers[2]!(listed('New'))
    answers[3]!([])
    await flush()
    expect(useArtifactsStore.getState().list).toEqual(listed('New'))
    artifactListShown(false)
  })

  it('keeps the lists through a failed read, says why, and retries', async () => {
    useArtifactsStore.setState({ list: listed('Kept'), deleted: [] })
    request.mockRejectedValue(new Error('The agent host stopped'))
    artifactListShown(true)
    artifactsChanged()
    await flush()
    expect(useArtifactsStore.getState()).toMatchObject({
      list: listed('Kept'),
      error: 'The agent host stopped',
    })
    answer(listed('Fresh'))
    retryArtifacts()
    await flush()
    expect(useArtifactsStore.getState()).toMatchObject({ list: listed('Fresh'), error: null })
    artifactListShown(false)
  })
})

describe('importArtifact', () => {
  beforeEach(() => useArtifactsStore.setState({ importFailed: null }))

  it('gives the new id, and nothing when the dialog was cancelled', async () => {
    importFile.mockResolvedValueOnce({ id: 'art_2' })
    expect(await importArtifact('/work/acme')).toBe('art_2')
    expect(importFile).toHaveBeenLastCalledWith('/work/acme')
    importFile.mockResolvedValueOnce(null)
    expect(await importArtifact(null)).toBeNull()
    expect(useArtifactsStore.getState().importFailed).toBeNull()
  })

  it('keeps why an import failed until the next one starts', async () => {
    importFile.mockResolvedValueOnce({ failed: 'too_large' })
    expect(await importArtifact(null)).toBeNull()
    expect(useArtifactsStore.getState().importFailed).toBe('too_large')
    importFile.mockRejectedValueOnce(new Error('No window'))
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await importArtifact(null)
    expect(useArtifactsStore.getState().importFailed).toBe('failed')
    importFile.mockResolvedValueOnce({ id: 'art_3' })
    await importArtifact(null)
    expect(useArtifactsStore.getState().importFailed).toBeNull()
  })
})
