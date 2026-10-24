import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { usesPrebuilds } from './app-deps.mjs'

const nodePtyDir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))

describe('usesPrebuilds', () => {
  it('uses the binaries node-pty ships for Windows on x64 and arm64', () => {
    expect(usesPrebuilds('win32', 'x64', nodePtyDir)).toBe(true)
    expect(usesPrebuilds('win32', 'arm64', nodePtyDir)).toBe(true)
  })

  it('compiles for a Windows architecture node-pty ships nothing for', () => {
    expect(usesPrebuilds('win32', 'ia32', nodePtyDir)).toBe(false)
  })

  it('compiles on macOS even though node-pty ships binaries for it', () => {
    expect(usesPrebuilds('darwin', 'arm64', nodePtyDir)).toBe(false)
    expect(usesPrebuilds('darwin', 'x64', nodePtyDir)).toBe(false)
  })

  it('compiles on Linux', () => {
    expect(usesPrebuilds('linux', 'x64', nodePtyDir)).toBe(false)
  })

  // The reason macOS compiles; once node-pty ships it executable, its prebuilt binaries may do.
  it.skipIf(process.platform === 'win32')(
    "finds node-pty's prebuilt macOS spawn-helper not executable",
    () => {
      for (const arch of ['arm64', 'x64']) {
        const { mode } = statSync(join(nodePtyDir, 'prebuilds', `darwin-${arch}`, 'spawn-helper'))
        expect(mode & 0o111).toBe(0)
      }
    },
  )
})
