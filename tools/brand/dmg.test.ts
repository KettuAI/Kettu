import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Configuration } from 'electron-builder'
import { describe, expect, it } from 'vitest'
import { DMG_LAYOUT } from './dmg-layout.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const CONFIGS = ['electron-builder.yml', 'electron-builder.mac-signed.yml']

// electron-builder's own loader, so `extends` merges as it does in a build.
const builderRequire = createRequire(
  createRequire(import.meta.url).resolve('electron-builder/package.json'),
)
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config') as {
  getConfig: (projectDir: string, configPath: string, options: null) => Promise<Configuration>
}

const dmgOf = async (file: string) => (await getConfig(root, file, null)).dmg

/** A PNG's size in pixels, from its IHDR chunk. */
function pngSize(file: string) {
  const png = readFileSync(join(root, file))
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe.each(CONFIGS)('%s', (file) => {
  it('places and sizes the icons as the backgrounds are drawn for', async () => {
    const dmg = await dmgOf(file)
    expect(dmg?.iconSize).toBe(DMG_LAYOUT.iconSize)
    expect(dmg?.iconTextSize).toBe(DMG_LAYOUT.iconTextSize)
    expect(dmg?.contents).toMatchObject([
      DMG_LAYOUT.app,
      { ...DMG_LAYOUT.applications, type: 'link', path: '/Applications' },
    ])
  })

  it('names a background drawn at the window size, and twice that for Retina', async () => {
    const background = (await dmgOf(file))?.background
    if (!background) throw new Error(`${file} names no dmg background`)
    const { width, height } = DMG_LAYOUT
    expect(pngSize(background)).toEqual({ width, height })
    expect(pngSize(background.replace(/\.png$/, '@2x.png'))).toEqual({
      width: width * 2,
      height: height * 2,
    })
  })
})

describe('first-launch lines', () => {
  it('are on the ad-hoc background and not on the Developer ID one', async () => {
    expect((await dmgOf('electron-builder.yml'))?.background).toBe('build/dmg-background.png')
    expect((await dmgOf('electron-builder.mac-signed.yml'))?.background).toBe(
      'build/dmg-background-signed.png',
    )
  })
})
