import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempFolder } from './temp'

describe('tempFolder', () => {
  let made = ''
  let writes = false

  afterEach(async () => {
    if (!writes) return
    writes = false
    // As a stopping host writes its state: into its folder, made again if it is gone.
    await mkdir(made, { recursive: true })
    await writeFile(path.join(made, 'state.json'), '{}')
  })

  it('makes a folder in the system temp folder', async () => {
    made = await tempFolder('kettu-temp-')
    writes = true
    expect(path.basename(made)).toMatch(/^kettu-temp-/)
    expect(existsSync(made)).toBe(true)
  })

  it('removes it once the test that made it and its afterEach hooks have finished', () => {
    expect(made).not.toBe('')
    expect(existsSync(made)).toBe(false)
  })
})
