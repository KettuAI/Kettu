import { PuzzleIcon } from '@hugeicons/core-free-icons'
import { describe, expect, it, vi } from 'vitest'
import { communitySubject, kettuPluginSubject, tileArt } from './tile-art'

// The catalog's model reads the window's stores, which a Kettu plugin's tile never needs.
vi.mock('./model', () => ({ pluginName: (id: string) => id }))

const ICON = 'data:image/png;base64,AAAA'

describe('a Kettu plugin’s tile', () => {
  it('shows the package’s own icon first, for any publisher', () => {
    expect(tileArt(kettuPluginSubject({ name: 'linear', official: true, icon: ICON }))).toEqual({
      type: 'image',
      src: ICON,
    })
    expect(tileArt(kettuPluginSubject({ name: 'my-notes', icon: ICON }))).toEqual({
      type: 'image',
      src: ICON,
    })
  })

  it('takes the bundled mark by name only for Kettu’s own publisher', () => {
    expect(tileArt(kettuPluginSubject({ name: 'linear', official: true }))).toMatchObject({
      type: 'mark',
    })
    expect(tileArt(kettuPluginSubject({ name: 'linear' }))).toMatchObject({
      type: 'glyph',
      icon: PuzzleIcon,
    })
  })

  it('draws the puzzle on a color its name picks, the same each time', () => {
    const art = tileArt(kettuPluginSubject({ name: 'ntfy', official: true }))
    expect(art).toMatchObject({ type: 'glyph', icon: PuzzleIcon })
    expect(tileArt(kettuPluginSubject({ name: 'ntfy' }))).toEqual(art)
  })

  it('reads a listing’s icon, official or not', () => {
    const item = { id: 'plugaaaa23', kind: 'agent-plugin', slug: 'sentry' } as const
    expect(tileArt(communitySubject({ ...item, icon: ICON }))).toEqual({ type: 'image', src: ICON })
    expect(tileArt(communitySubject({ ...item, official: true }))).toMatchObject({ type: 'mark' })
    expect(tileArt(communitySubject({ ...item, icon: null }))).toMatchObject({ type: 'glyph' })
    expect(tileArt(communitySubject({ ...item, kind: 'skill', icon: ICON }))).not.toMatchObject({
      type: 'image',
    })
  })
})
