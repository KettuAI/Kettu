import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactSummary } from '@shared/artifacts'
import {
  attachArtifactToDraft,
  draftArtifactAttachments,
  formatAttachedArtifactsPrompt,
  hydrateDraftArtifactAttachments,
  keepHostArtifactAttachments,
  removeAttachedArtifact,
  restoreDraftArtifactAttachments,
  selectableArtifacts,
  setDraftArtifactAttachments,
  splitAttachedArtifactsPrompt,
  toAttachedArtifact,
  type AttachedArtifact,
} from './artifact-attachments'
import {
  clearDraft,
  draftedSessions,
  flushDraft,
  hasMessage,
  NEW_SESSION_DRAFT,
  readDraftArtifacts,
  writeDraftArtifacts,
} from './drafts'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size
  },
})

const ID_1 = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D1'
const ID_2 = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D2'
const ID_3 = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
const ID_4 = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D4'
const ID_5 = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D5'
const ID_6 = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D6'

function summary(overrides: Partial<ArtifactSummary> & { id: string }): ArtifactSummary {
  return {
    title: 'Untitled',
    project: '/repo/alpha',
    scratch: false,
    sessionId: 'sess-1',
    version: 1,
    pages: 1,
    canvas: false,
    files: 1,
    size: 1024,
    createdAt: 1_000,
    updatedAt: 2_000,
    deletedAt: null,
    editing: [],
    type: null,
    ...overrides,
  }
}

beforeEach(() => {
  store.clear()
  for (const draft of ['sess-1', 'sess-2', NEW_SESSION_DRAFT]) {
    setDraftArtifactAttachments(draft, [])
    clearDraft(draft)
  }
})

describe('selectableArtifacts', () => {
  const hostMap = new Map<string, string | null>([[ID_6, 'remote-host-1']])
  const hostOf = (id: string) => hostMap.get(id) ?? null

  const fixture: ArtifactSummary[] = [
    summary({ id: ID_1, title: 'Older Spec', updatedAt: 100, type: 'document' }),
    summary({ id: ID_2, title: 'Newest Canvas', updatedAt: 500, canvas: true, pages: 4 }),
    summary({ id: ID_3, title: 'Deleted Deck', updatedAt: 900, deletedAt: 950, type: 'slides' }),
    summary({ id: ID_4, title: 'Other Project Page', project: '/repo/beta', updatedAt: 700 }),
    summary({
      id: ID_5,
      title: 'Scratch Notes',
      project: '/scratch/1',
      scratch: true,
      updatedAt: 600,
      type: 'document',
    }),
    summary({
      id: ID_6,
      title: 'Remote Host Spec',
      project: '/repo/alpha',
      updatedAt: 800,
      type: 'document',
    }),
  ]

  it('filters to non-deleted artifacts in the current project, sorted newest first', () => {
    const result = selectableArtifacts(fixture, {
      projectPath: '/repo/alpha',
      hostId: null,
      hostOfArtifact: hostOf,
    })
    expect(result.items.map((a) => a.id)).toEqual([ID_2, ID_1])
    expect(result.scopeCount).toBe(2)
    expect(result.availableCount).toBe(2)
  })

  it('excludes already-attached artifacts and deduplicates input ids', () => {
    const duplicated = [fixture[0]!, fixture[1]!, fixture[1]!]
    const result = selectableArtifacts(duplicated, {
      projectPath: '/repo/alpha',
      hostId: null,
      attachedIds: new Set([ID_2]),
      hostOfArtifact: hostOf,
    })
    expect(result.items.map((a) => a.id)).toEqual([ID_1])
    expect(result.scopeCount).toBe(2)
    expect(result.availableCount).toBe(1)
  })

  it('shows scratch artifacts when No project is selected', () => {
    const result = selectableArtifacts(fixture, {
      projectPath: null,
      noProject: true,
      hostId: null,
      hostOfArtifact: hostOf,
    })
    expect(result.items.map((a) => a.id)).toEqual([ID_5])
  })

  it('falls back to recent host artifacts when no project is chosen yet', () => {
    const result = selectableArtifacts(fixture, {
      projectPath: null,
      noProject: false,
      hostId: null,
      hostOfArtifact: hostOf,
    })
    expect(result.items.map((a) => a.id)).toEqual([ID_4, ID_5, ID_2, ID_1])
  })

  it('scopes artifacts strictly to the target remote host', () => {
    const result = selectableArtifacts(fixture, {
      projectPath: '/repo/alpha',
      hostId: 'remote-host-1',
      hostOfArtifact: hostOf,
    })
    expect(result.items.map((a) => a.id)).toEqual([ID_6])
  })

  it('filters by case- and accent-insensitive query against title, kind, and id', () => {
    const accented = [
      summary({ id: ID_1, title: 'Café Launch Spec', updatedAt: 100, type: 'document' }),
      summary({ id: ID_2, title: 'Pricing Slides', updatedAt: 200, type: 'slides' }),
    ]
    expect(
      selectableArtifacts(accented, {
        projectPath: '/repo/alpha',
        hostId: null,
        query: 'cafe',
        hostOfArtifact: () => null,
      }).items.map((a) => a.id),
    ).toEqual([ID_1])

    expect(
      selectableArtifacts(accented, {
        projectPath: '/repo/alpha',
        hostId: null,
        query: 'slides',
        hostOfArtifact: () => null,
      }).items.map((a) => a.id),
    ).toEqual([ID_2])

    expect(
      selectableArtifacts(accented, {
        projectPath: '/repo/alpha',
        hostId: null,
        query: ID_1,
        hostOfArtifact: () => null,
      }).items.map((a) => a.id),
    ).toEqual([ID_1])
  })
})

describe('formatAttachedArtifactsPrompt & splitAttachedArtifactsPrompt', () => {
  const doc: AttachedArtifact = {
    id: ID_1,
    title: 'Release Architecture Spec',
    kind: 'document',
  }
  const canvas: AttachedArtifact = {
    id: ID_2,
    title: 'Onboarding Flow [v2]',
    kind: 'canvas',
  }

  it('returns the original text unchanged when no artifacts are attached', () => {
    expect(formatAttachedArtifactsPrompt('Hello world', [])).toBe('Hello world')
    expect(formatAttachedArtifactsPrompt('', [])).toBe('')
  })

  it('formats a single attached artifact with user text and round-trips cleanly', () => {
    const prompt = formatAttachedArtifactsPrompt('Review the timeline section.', [doc])
    expect(prompt).toBe(
      [
        'Review the timeline section.',
        '',
        'Attached artifact (use `read_artifact` to inspect):',
        `- [Release Architecture Spec](kettu://artifact/${ID_1}) (\`${ID_1}\`, document)`,
      ].join('\n'),
    )
    expect(splitAttachedArtifactsPrompt(prompt)).toEqual({
      text: 'Review the timeline section.',
      artifacts: [doc],
    })
  })

  it('formats multiple attached artifacts with user text, deduplicating ids and escaping brackets', () => {
    const prompt = formatAttachedArtifactsPrompt('Compare these artifacts.', [doc, canvas, doc])
    expect(prompt).toBe(
      [
        'Compare these artifacts.',
        '',
        'Attached artifacts (use `read_artifact` to inspect):',
        `- [Release Architecture Spec](kettu://artifact/${ID_1}) (\`${ID_1}\`, document)`,
        `- [Onboarding Flow \\[v2\\]](kettu://artifact/${ID_2}) (\`${ID_2}\`, canvas)`,
      ].join('\n'),
    )
    expect(splitAttachedArtifactsPrompt(prompt)).toEqual({
      text: 'Compare these artifacts.',
      artifacts: [doc, canvas],
    })
  })

  it('formats attached artifacts without user text', () => {
    const single = formatAttachedArtifactsPrompt('   ', [doc])
    expect(single).toBe(
      [
        'Attached artifact (use `read_artifact` to inspect):',
        `- [Release Architecture Spec](kettu://artifact/${ID_1}) (\`${ID_1}\`, document)`,
      ].join('\n'),
    )
    expect(splitAttachedArtifactsPrompt(single)).toEqual({ text: '', artifacts: [doc] })

    const multiple = formatAttachedArtifactsPrompt('', [doc, canvas])
    expect(multiple).toBe(
      [
        'Attached artifacts (use `read_artifact` to inspect):',
        `- [Release Architecture Spec](kettu://artifact/${ID_1}) (\`${ID_1}\`, document)`,
        `- [Onboarding Flow \\[v2\\]](kettu://artifact/${ID_2}) (\`${ID_2}\`, canvas)`,
      ].join('\n'),
    )
    expect(splitAttachedArtifactsPrompt(multiple)).toEqual({ text: '', artifacts: [doc, canvas] })
  })

  it('returns null from splitAttachedArtifactsPrompt for plain user messages', () => {
    expect(splitAttachedArtifactsPrompt('Just a regular message')).toBeNull()
    expect(
      splitAttachedArtifactsPrompt(
        'Attached artifact (use `read_artifact` to inspect):\n- not a real link',
      ),
    ).toBeNull()
  })
})

describe('composer and new-session attached artifact state', () => {
  const first = toAttachedArtifact(
    summary({ id: ID_1, title: 'Architecture Spec', type: 'document' }),
    null,
  )
  const second = toAttachedArtifact(
    summary({ id: ID_2, title: 'Launch Deck', type: 'slides' }),
    null,
  )
  const remote = toAttachedArtifact(
    summary({ id: ID_6, title: 'Remote Page', type: null }),
    'remote-host-1',
  )

  it('attaches multiple artifacts, deduplicates repeats, and removes individual chips in a session', () => {
    expect(attachArtifactToDraft('sess-1', first)).toBe(true)
    expect(attachArtifactToDraft('sess-1', first)).toBe(false)
    expect(attachArtifactToDraft('sess-1', second)).toBe(true)

    expect(draftArtifactAttachments('sess-1')).toEqual([first, second])
    expect(hasMessage('', [], draftArtifactAttachments('sess-1'))).toBe(true)

    removeAttachedArtifact('sess-1', first.id)
    expect(draftArtifactAttachments('sess-1')).toEqual([second])

    // Clearing on send empties both memory and persisted draft.
    setDraftArtifactAttachments('sess-1', [])
    flushDraft('sess-1')
    expect(draftArtifactAttachments('sess-1')).toEqual([])
    expect(readDraftArtifacts('sess-1')).toEqual([])
    expect(hasMessage('', [], draftArtifactAttachments('sess-1'))).toBe(false)
  })

  it('keeps New session attached artifacts persisted before send, clears on send, and restores on failure', () => {
    attachArtifactToDraft(NEW_SESSION_DRAFT, first)
    attachArtifactToDraft(NEW_SESSION_DRAFT, second)
    flushDraft(NEW_SESSION_DRAFT)

    expect(readDraftArtifacts(NEW_SESSION_DRAFT)).toEqual([first, second])

    // Simulate send taking & clearing the New session draft.
    const taken = draftArtifactAttachments(NEW_SESSION_DRAFT)
    setDraftArtifactAttachments(NEW_SESSION_DRAFT, [])
    clearDraft(NEW_SESSION_DRAFT)
    expect(draftArtifactAttachments(NEW_SESSION_DRAFT)).toEqual([])

    // Simulate send failure restoring chips without losing newly attached items.
    const third: AttachedArtifact = { id: ID_3, title: 'Follow-up Note', kind: 'web' }
    attachArtifactToDraft(NEW_SESSION_DRAFT, third)
    restoreDraftArtifactAttachments(NEW_SESSION_DRAFT, taken)
    expect(draftArtifactAttachments(NEW_SESSION_DRAFT)).toEqual([first, second, third])
  })

  it('hydrates saved artifacts and counts artifact-only session drafts in draftedSessions', () => {
    writeDraftArtifacts('sess-2', [first])
    flushDraft('sess-2')
    expect(draftedSessions()).toContain('sess-2')

    hydrateDraftArtifactAttachments('sess-2')
    expect(draftArtifactAttachments('sess-2')).toEqual([first])
  })

  it('drops artifacts belonging to another host when switching hosts', () => {
    attachArtifactToDraft(NEW_SESSION_DRAFT, first)
    attachArtifactToDraft(NEW_SESSION_DRAFT, remote)
    keepHostArtifactAttachments(NEW_SESSION_DRAFT, 'remote-host-1')
    expect(draftArtifactAttachments(NEW_SESSION_DRAFT)).toEqual([remote])
  })
})
