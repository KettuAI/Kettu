import { describe, expect, it } from 'vitest'
import { fileType, gridTiles, mediaRows } from './layout'

describe('mediaRows', () => {
  it('keeps one picture and other media as rows of their own', () => {
    expect(mediaRows(['a.png', 'b.mp4', 'c.mp3'])).toEqual([
      { kind: 'one', path: 'a.png' },
      { kind: 'one', path: 'b.mp4' },
      { kind: 'one', path: 'c.mp3' },
    ])
  })

  it('gathers two or more pictures into one grid where the first stands', () => {
    expect(mediaRows(['clip.mov', 'a.png', 'song.mp3', 'b.jpg', 'c.svg'])).toEqual([
      { kind: 'one', path: 'clip.mov' },
      { kind: 'grid', paths: ['a.png', 'b.jpg', 'c.svg'] },
      { kind: 'one', path: 'song.mp3' },
    ])
  })

  it('shows nothing for no media', () => {
    expect(mediaRows([])).toEqual([])
  })
})

describe('gridTiles', () => {
  it('shows every picture up to three', () => {
    expect(gridTiles(['a.png', 'b.png'])).toEqual({ tiles: ['a.png', 'b.png'], more: 0 })
    expect(gridTiles(['a.png', 'b.png', 'c.png'])).toEqual({
      tiles: ['a.png', 'b.png', 'c.png'],
      more: 0,
    })
  })

  it('counts the pictures past the third on the last tile', () => {
    expect(gridTiles(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.png`))).toEqual({
      tiles: ['a.png', 'b.png', 'c.png'],
      more: 3,
    })
  })
})

describe('fileType', () => {
  it('names the extension in capitals', () => {
    expect(fileType('usage-oct.csv')).toBe('CSV')
    expect(fileType('clip.final.MkV', 'video/x-matroska')).toBe('MKV')
  })

  it('falls back to a short MIME subtype', () => {
    expect(fileType('Video', 'video/mp4')).toBe('MP4')
    expect(fileType('Picture', 'image/svg+xml')).toBe('SVG')
    expect(fileType('Clip', 'video/x-matroska')).toBeNull()
    expect(fileType('Clip', 'video/quicktime')).toBeNull()
  })

  it('names nothing for a dotfile, a long extension or no type', () => {
    expect(fileType('.env')).toBeNull()
    expect(fileType('archive.tarball')).toBeNull()
    expect(fileType('README')).toBeNull()
  })
})
