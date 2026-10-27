import { describe, expect, it } from 'vitest'
import { configFolderChoice } from './config-folder'

describe('configFolderChoice', () => {
  it('opens the step and clears nothing when a folder of its own is picked with none chosen', () => {
    expect(configFolderChoice('custom', { chosen: false, choosing: false })).toEqual({
      open: true,
      clear: false,
    })
  })

  it('changes nothing when a folder of its own is picked with one chosen', () => {
    expect(configFolderChoice('custom', { chosen: true, choosing: false })).toEqual({
      open: false,
      clear: false,
    })
  })

  it('closes the step and clears nothing when the environment is picked while it is open', () => {
    expect(configFolderChoice('environment', { chosen: false, choosing: true })).toEqual({
      open: false,
      clear: false,
    })
  })

  it('clears the chosen folder when the environment is picked', () => {
    expect(configFolderChoice('environment', { chosen: true, choosing: false })).toEqual({
      open: false,
      clear: true,
    })
  })
})
