import { useEffect, useState } from 'react'
import { paramsRange, parseParams, type PageParam } from '@shared/artifact-params'
import type { CanvasPage } from '@shared/canvas-doc'
import { host } from '@renderer/lib/host'

/** The most frames whose files are read for their parameters at once. */
const READ_FRAMES = 60

/** Each version's files are fixed, so what one declares is read once. */
const read = new Map<string, Promise<PageParam[]>>()

function paramsOf(artifactId: string, version: number, file: string): Promise<PageParam[]> {
  const key = `${artifactId}:${version}:${file}`
  let found = read.get(key)
  if (!found) {
    found = host('artifacts.file', { id: artifactId, version, path: file }).then(
      ({ bytes }) => {
        const html = new TextDecoder().decode(bytes)
        const range = paramsRange(html)
        return range ? parseParams(html.slice(range.start, range.end)) : []
      },
      () => [],
    )
    read.set(key, found)
  }
  return found
}

/** The parameters the frames declare, by frame id; a frame that declares none is left out. */
export function useFrameParams(
  artifactId: string,
  version: number | null,
  pages: readonly CanvasPage[],
): ReadonlyMap<string, PageParam[]> {
  const [found, setFound] = useState<{
    artifactId: string
    params: Map<string, PageParam[]>
  } | null>(null)
  const wanted = pages.slice(0, READ_FRAMES)
  const key = `${artifactId}:${version}:${wanted.map((p) => `${p.id}=${p.file}`).join(',')}`
  useEffect(() => {
    if (version === null) return
    let live = true
    void Promise.all(wanted.map((p) => paramsOf(artifactId, version, p.file))).then((all) => {
      if (!live) return
      const params = new Map<string, PageParam[]>()
      all.forEach((list, i) => {
        if (list.length > 0) params.set(wanted[i]!.id, list)
      })
      setFound({ artifactId, params })
    })
    return () => {
      live = false
    }
    // `key` names the frames and their files; `wanted` changes with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // A new version keeps showing what the last one declared until its files are read, so the
  // Tweaks panel does not empty and lose its state after each save.
  return found?.artifactId === artifactId ? found.params : EMPTY
}

const EMPTY: ReadonlyMap<string, PageParam[]> = new Map()
