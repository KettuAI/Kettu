import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseThumbnailPart } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import { partPlan } from './part-thumbnails'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Found = Extract<ArtifactContentResult, { kind: 'found' }>

/** A version whose files lie as this computer keeps them, each named by its hash. */
function version(files: Record<string, string>, type: Found['type'] = null): Found {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-parts-'))
  dirs.push(dir)
  return {
    kind: 'found',
    version: 1,
    title: 'T',
    key: 'f'.repeat(64),
    strict: false,
    type,
    files: Object.entries(files).map(([filePath, text]) => {
      const file = path.join(dir, `${createHash('sha256').update(text).digest('hex')}.html`)
      writeFileSync(file, text)
      return { path: filePath, file, size: text.length }
    }),
  }
}

const canvas = JSON.stringify({
  format: 1,
  canvases: [{ id: 'c1', name: 'Home' }],
  pages: ['a', 'b'].map((id, i) => ({
    id: `p${id}`,
    canvas: 'c1',
    name: id,
    file: `${id}.html`,
    x: i * 500,
    y: 0,
    width: 390,
    height: 844,
    locked: false,
  })),
  notes: [],
})

describe('the thumbnail of a part', () => {
  it("keeps a frame's image while its file and the shared files stay the same", async () => {
    const one = version({ 'canvas.json': canvas, 'a.html': 'A', 'b.html': 'B', 'app.css': 'x' })
    const two = version({ 'canvas.json': canvas, 'a.html': 'A', 'b.html': 'B2', 'app.css': 'x' })
    const three = version({ 'canvas.json': canvas, 'a.html': 'A', 'b.html': 'B2', 'app.css': 'y' })
    const name = async (found: Found, frame: string) =>
      (await partPlan(found, { frame }, '1.0.0'))?.name
    expect(await name(one, 'pa')).toBe(await name(two, 'pa'))
    expect(await name(one, 'pb')).not.toBe(await name(two, 'pb'))
    expect(await name(two, 'pa')).not.toBe(await name(three, 'pa'))
    expect(await partPlan(one, { frame: 'pa' }, '1.0.0')).toMatchObject({
      kind: 'frame',
      file: 'a.html',
      size: { width: 390, height: 844 },
    })
    expect(await partPlan(one, { frame: 'nope' }, '1.0.0')).toBeNull()
    expect(await partPlan(one, { slide: 1 }, '1.0.0')).toBeNull()
  })

  it('keeps a slide by its own content, and a document per theme', async () => {
    const deck = (second: string) =>
      JSON.stringify({
        slides: [
          { layout: 'title', title: 'A' },
          { layout: 'title', title: second },
        ],
      })
    const slides = { name: 'slides', format: 1 } as const
    const one = version({ 'slides.json': deck('B') }, slides)
    const two = version({ 'slides.json': deck('B2') }, slides)
    const name = async (found: Found, slide: number) =>
      (await partPlan(found, { slide }, '1.0.0'))?.name
    expect(await name(one, 1)).toBe(await name(two, 1))
    expect(await name(one, 2)).not.toBe(await name(two, 2))
    expect(await partPlan(one, { slide: 3 }, '1.0.0')).toBeNull()
    expect(await partPlan(one, { slide: 2 }, '1.0.0')).toMatchObject({ viewer: { slide: 2 } })
    // A new app draws its viewer's slides again.
    expect((await partPlan(one, { slide: 1 }, '1.0.1'))?.name).not.toBe(await name(one, 1))

    const doc = version({ 'document.md': '# Hi' }, { name: 'document', format: 1 })
    const light = await partPlan(doc, { theme: 'light' }, '1.0.0')
    const dark = await partPlan(doc, { theme: 'dark' }, '1.0.0')
    expect(dark).toMatchObject({ viewer: { theme: 'dark' } })
    expect(light?.name).not.toBe(dark?.name)
    expect(await partPlan(one, { theme: 'dark' }, '1.0.0')).toBeNull()
  })

  it('takes only a frame id, a slide number or a theme from a client', () => {
    expect(parseThumbnailPart({ frame: 'p_1' })).toEqual({ frame: 'p_1' })
    expect(parseThumbnailPart({ slide: 2 })).toEqual({ slide: 2 })
    expect(parseThumbnailPart({ theme: 'dark' })).toEqual({ theme: 'dark' })
    for (const bad of [
      null,
      [],
      { frame: '../x' },
      { frame: 'a', slide: 1 },
      { slide: 0 },
      { slide: 1.5 },
      { theme: 'sepia' },
    ]) {
      expect(parseThumbnailPart(bad)).toBeNull()
    }
  })
})
