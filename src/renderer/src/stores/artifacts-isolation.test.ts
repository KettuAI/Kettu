import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSummary } from '@shared/artifacts'

vi.mock('@renderer/lib/platform', () => ({
  isMac: true,
  isWindows: false,
  isLinux: false,
  isMod: () => false,
  isWeb: false,
  platform: 'darwin',
  hasBand: false,
  formatShortcut: (shortcut: string) => shortcut,
}))

import { canShow } from '@renderer/app/history'
import {
  attachArtifactToDraft,
  draftArtifactAttachments,
  setDraftArtifactAttachments,
} from '@renderer/features/session/composer/artifact-attachments'
import { clearArtifactViewerState, setViewerState, useArtifactViewerStore } from './artifact-viewer'
import { artifactStanding, useArtifactsStore } from './artifacts'
import { closeHiddenArtifacts, openArtifact, openArtifactTab, useViewStore } from './view'

const ART_A = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D1'
const ART_LOCAL = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D2'
const ART_ERASED = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

const summary = (id: string, title: string): ArtifactSummary => ({
  id,
  title,
  project: '/p',
  scratch: false,
  sessionId: 's1',
  version: 1,
  pages: 1,
  canvas: false,
  files: 1,
  size: 100,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  seen: 1,
  type: null,
  editing: [],
})

describe('renderer artifact account isolation state', () => {
  beforeEach(() => {
    useArtifactsStore.setState({
      list: [summary(ART_A, 'A Secret'), summary(ART_LOCAL, 'Local Doc')],
      deleted: [],
      hidden: new Set(),
      hostsRead: [],
      dialog: null,
      paneSelection: null,
    })
    useViewStore.setState({
      main: { kind: 'artifacts' },
      sidePane: {},
      sideLast: {},
      sideTabs: {},
      sideOrder: {},
      sideDocs: {},
      sideDoc: {},
      sideArtifactPage: {},
    })
    clearArtifactViewerState()
    setDraftArtifactAttachments('s1', [])
  })

  it('distinguishes hidden (other-account) artifacts from erased ones and updates view/history/drafts on switch', () => {
    // Under A: open A's viewer, side tab, viewer state, and attach both A and Local to a draft.
    openArtifact(ART_A)
    openArtifactTab('s1', ART_A)
    openArtifactTab('s1', ART_LOCAL)
    setViewerState(ART_A, { mode: 'edit' })
    setViewerState(ART_LOCAL, { mode: 'comment' })
    attachArtifactToDraft('s1', { id: ART_A, title: 'A Secret', kind: 'web' })
    attachArtifactToDraft('s1', { id: ART_LOCAL, title: 'Local Doc', kind: 'web' })

    expect(useViewStore.getState().main).toMatchObject({ kind: 'artifact', id: ART_A })
    expect(useViewStore.getState().sideDocs['s1']?.map((t) => t.id)).toEqual([ART_A, ART_LOCAL])
    expect(draftArtifactAttachments('s1').map((a) => a.id)).toEqual([ART_A, ART_LOCAL])

    // Switch to B: ART_A moves into `hidden`, ART_LOCAL stays live, ART_ERASED is neither.
    const hidden = new Set([ART_A])
    useArtifactsStore.setState({
      list: [summary(ART_LOCAL, 'Local Doc')],
      deleted: [],
      hidden,
    })
    closeHiddenArtifacts(hidden)
    clearArtifactViewerState(hidden)

    const state = useArtifactsStore.getState()
    expect(artifactStanding(state, ART_A)).toBe('hidden')
    expect(artifactStanding(state, ART_LOCAL)).toBe('live')
    expect(artifactStanding(state, ART_ERASED)).toBe('erased')

    // Viewer closed back to the artifacts list; A's side tab removed while local tab stays.
    expect(useViewStore.getState().main).toEqual({ kind: 'artifacts' })
    expect(useViewStore.getState().sideDocs['s1']?.map((t) => t.id)).toEqual([ART_LOCAL])
    expect(useArtifactViewerStore.getState().byId[ART_A]).toBeUndefined()
    expect(useArtifactViewerStore.getState().byId[ART_LOCAL]?.mode).toBe('comment')

    // History cannot reopen the hidden artifact; draft hides A without erasing underlying draft data.
    expect(canShow({ kind: 'artifact', id: ART_A, back: { kind: 'artifacts' } })).toBe(false)
    expect(canShow({ kind: 'artifact', id: ART_LOCAL, back: { kind: 'artifacts' } })).toBe(true)
    expect(draftArtifactAttachments('s1').map((a) => a.id)).toEqual([ART_LOCAL])

    // Switch back to A: ART_A becomes live again and draft attachment returns intact.
    useArtifactsStore.setState({
      list: [summary(ART_A, 'A Secret'), summary(ART_LOCAL, 'Local Doc')],
      deleted: [],
      hidden: new Set(),
    })
    expect(artifactStanding(useArtifactsStore.getState(), ART_A)).toBe('live')
    expect(canShow({ kind: 'artifact', id: ART_A, back: { kind: 'artifacts' } })).toBe(true)
    expect(draftArtifactAttachments('s1').map((a) => a.id)).toEqual([ART_A, ART_LOCAL])
  })
})
