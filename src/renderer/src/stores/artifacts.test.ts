import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSummary } from '@shared/artifacts'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const { artifactsChanged, artifactsPageShown, retryArtifacts, useArtifactsStore } =
  await import('./artifacts')

const listed = (title: string) => [{ id: 'art_1', title } as ArtifactSummary]
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('artifacts store', () => {
  beforeEach(() => {
    request.mockReset()
    useArtifactsStore.setState({ list: null, error: null, filter: '', opened: null })
  })

  it('reads when the page shows, then follows changes only while it shows', async () => {
    request.mockResolvedValue(listed('One'))
    artifactsPageShown(true)
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(useArtifactsStore.getState().list).toEqual(listed('One'))

    artifactsPageShown(false)
    artifactsPageShown(true)
    await flush()
    expect(request).toHaveBeenCalledTimes(1)

    artifactsPageShown(false)
    artifactsChanged()
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValue(listed('Two'))
    artifactsPageShown(true)
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(useArtifactsStore.getState().list).toEqual(listed('Two'))
    artifactsPageShown(false)
  })

  it('reads once more for changes that arrive while a read runs', async () => {
    const answers: ((list: ArtifactSummary[]) => void)[] = []
    request.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    artifactsPageShown(true)
    artifactsChanged()
    artifactsChanged()
    expect(request).toHaveBeenCalledTimes(1)
    answers[0]!(listed('Old'))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    answers[1]!(listed('New'))
    await flush()
    expect(useArtifactsStore.getState().list).toEqual(listed('New'))
    artifactsPageShown(false)
  })

  it('keeps the list through a failed read, says why, and retries', async () => {
    useArtifactsStore.setState({ list: listed('Kept') })
    request.mockRejectedValue(new Error('The agent host stopped'))
    artifactsPageShown(true)
    artifactsChanged()
    await flush()
    expect(useArtifactsStore.getState()).toMatchObject({
      list: listed('Kept'),
      error: 'The agent host stopped',
    })
    request.mockResolvedValue(listed('Fresh'))
    retryArtifacts()
    await flush()
    expect(useArtifactsStore.getState()).toMatchObject({ list: listed('Fresh'), error: null })
    artifactsPageShown(false)
  })
})
