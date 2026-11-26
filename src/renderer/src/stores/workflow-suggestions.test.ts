import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowSuggestion } from '@shared/workflow'

const hostAtMock = vi.fn()

vi.mock('@renderer/lib/host', () => ({
  hostAt: (...args: unknown[]) => hostAtMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

function suggestion(
  id: string,
  answer: WorkflowSuggestion['answer'] = { kind: 'waiting' },
): WorkflowSuggestion {
  return {
    id,
    sessionId: 's1',
    purpose: 'start',
    source: { kind: 'library', workflowId: 'w1' },
    workflow: {
      format: 1,
      name: 'Bug Fix',
      description: 'Fix and review',
      locales: {},
      sendBackLimit: 3,
      steps: [
        {
          id: 'fix',
          name: 'Fix',
          prompt: 'Fix the bug',
          by: 'agent',
          handIn: 'outcome',
          outcomes: [{ name: 'Done', to: [], end: 'done', limit: null }],
          youReview: false,
          hint: null,
          reviewOf: [],
          tools: { mcp: [], skills: [] },
        },
      ],
    },
    hash: 'a'.repeat(64),
    approves: false,
    task: 'Fix login crash',
    title: 'Fix login crash',
    pace: 'balanced',
    paceReason: 'Standard change',
    agentId: 'claude-code',
    tools: [],
    facts: { pastMs: null, runs: 0, worktree: true },
    answer,
    createdAt: 1,
  }
}

describe('workflow-suggestions store', () => {
  beforeEach(() => {
    hostAtMock.mockReset()
  })

  afterEach(async () => {
    const { resetSuggestionsStore } = await import('./workflow-suggestions')
    resetSuggestionsStore()
    vi.resetModules()
  })

  it('loads session suggestions, records errors instead of failing silently, and retries cleanly', async () => {
    hostAtMock
      .mockRejectedValueOnce(new Error('Relay connection timed out'))
      .mockResolvedValueOnce([suggestion('wfs-abcdefghij23')])

    const { loadSuggestions, sessionKey, useSuggestionsStore } =
      await import('./workflow-suggestions')
    const key = sessionKey('s1', null)

    await loadSuggestions('s1', null, { requestedId: 'wfs-abcdefghij23' })
    expect(useSuggestionsStore.getState().sessions[key]).toEqual({
      status: 'error',
      error: 'Relay connection timed out',
      missed: [],
    })
    expect(useSuggestionsStore.getState().byId['wfs-abcdefghij23']).toBeUndefined()

    await loadSuggestions('s1', null, { force: true, requestedId: 'wfs-abcdefghij23' })
    expect(useSuggestionsStore.getState().sessions[key]).toEqual({
      status: 'loaded',
      error: null,
      missed: [],
    })
    expect(useSuggestionsStore.getState().byId['wfs-abcdefghij23']?.workflow.name).toBe('Bug Fix')
  })

  it('re-fetches when a new card id appears after an earlier load, and avoids infinite loops for missing ids', async () => {
    hostAtMock
      .mockResolvedValueOnce([suggestion('wfs-aaaaaaaaaaa2')])
      .mockResolvedValueOnce([suggestion('wfs-aaaaaaaaaaa2'), suggestion('wfs-bbbbbbbbbbb3')])
      .mockResolvedValueOnce([suggestion('wfs-aaaaaaaaaaa2'), suggestion('wfs-bbbbbbbbbbb3')])

    const { loadSuggestions, sessionKey, useSuggestionsStore } =
      await import('./workflow-suggestions')
    const key = sessionKey('s1', null)

    await loadSuggestions('s1', null, { requestedId: 'wfs-aaaaaaaaaaa2' })
    expect(hostAtMock).toHaveBeenCalledTimes(1)

    // New suggestion created while the mobile client was away: not in missed, so force fetch runs.
    await loadSuggestions('s1', null, { requestedId: 'wfs-bbbbbbbbbbb3' })
    expect(hostAtMock).toHaveBeenCalledTimes(2)
    expect(useSuggestionsStore.getState().byId['wfs-bbbbbbbbbbb3']).toBeDefined()

    // An id absent on the host is recorded in missed so subsequent non-forced loads do not loop.
    await loadSuggestions('s1', null, { requestedId: 'wfs-ccccccccccc4' })
    expect(hostAtMock).toHaveBeenCalledTimes(3)
    expect(useSuggestionsStore.getState().sessions[key]?.missed).toContain('wfs-ccccccccccc4')

    await loadSuggestions('s1', null, { requestedId: 'wfs-ccccccccccc4' })
    expect(hostAtMock).toHaveBeenCalledTimes(3)

    // A live event for the previously missing card clears it from missed.
    useSuggestionsStore.getState().receive(suggestion('wfs-ccccccccccc4'))
    expect(useSuggestionsStore.getState().sessions[key]?.missed).not.toContain('wfs-ccccccccccc4')
    expect(useSuggestionsStore.getState().byId['wfs-ccccccccccc4']).toBeDefined()
  })

  it('keeps newer live events during an in-flight read while refreshing stale cache on reconnect', async () => {
    let resolveFirst!: (value: WorkflowSuggestion[]) => void
    hostAtMock.mockImplementationOnce(
      () =>
        new Promise<WorkflowSuggestion[]>((resolve) => {
          resolveFirst = resolve
        }),
    )

    const { loadSuggestions, suggestionsHostOpened, useSuggestionsStore } =
      await import('./workflow-suggestions')

    const pending = loadSuggestions('s1', null, { requestedId: 'wfs-abcdefghij23' })
    // Live event arrives while the initial read is still in flight.
    useSuggestionsStore.getState().receive(suggestion('wfs-abcdefghij23', { kind: 'declined' }))

    // The older read finishes with stale 'waiting' state and must not overwrite the live event.
    resolveFirst([suggestion('wfs-abcdefghij23', { kind: 'waiting' })])
    await pending
    expect(useSuggestionsStore.getState().byId['wfs-abcdefghij23']?.answer).toEqual({
      kind: 'declined',
    })

    // After a reconnect, the host answers with an updated state (e.g. started on desktop) and refreshes cache.
    hostAtMock.mockResolvedValueOnce([
      suggestion('wfs-abcdefghij23', { kind: 'started', taskId: 't-1', items: [] }),
    ])
    suggestionsHostOpened(null)
    await vi.waitFor(() => {
      expect(useSuggestionsStore.getState().byId['wfs-abcdefghij23']?.answer.kind).toBe('started')
    })
  })

  it('tracks editing state per session, bumps nonce on repeated clicks, and clears when card resolves', async () => {
    const { editingSuggestionFor, loadSuggestions, useSuggestionsStore } =
      await import('./workflow-suggestions')

    const draftCard: WorkflowSuggestion = {
      ...suggestion('wfs-draftcard234'),
      source: { kind: 'draft', draftId: 'draft:abcdefghij23' },
    }
    const saveCard: WorkflowSuggestion = {
      ...suggestion('wfs-savecard2345'),
      purpose: 'save',
      source: { kind: 'draft', draftId: 'draft:234567abcdef' },
    }
    useSuggestionsStore.getState().receive(draftCard)
    useSuggestionsStore.getState().receive(saveCard)

    // Clicking Edit starts editing and bumps nonce on repeat clicks so attention feedback replays.
    useSuggestionsStore.getState().startEditing('s1', draftCard.id)
    expect(editingSuggestionFor(useSuggestionsStore.getState(), 's1')).toEqual({
      card: draftCard,
      nonce: 1,
    })

    useSuggestionsStore.getState().startEditing('s1', draftCard.id)
    expect(editingSuggestionFor(useSuggestionsStore.getState(), 's1')?.nonce).toBe(2)

    // Stopping with a mismatched cardId leaves the active edit intact.
    useSuggestionsStore.getState().stopEditing('s1', saveCard.id)
    expect(editingSuggestionFor(useSuggestionsStore.getState(), 's1')?.card.id).toBe(draftCard.id)

    // Live update resolving the card automatically clears its editing state.
    useSuggestionsStore
      .getState()
      .receive({ ...draftCard, answer: { kind: 'starting', items: [] } })
    expect(useSuggestionsStore.getState().editing['s1']).toBeUndefined()
    expect(editingSuggestionFor(useSuggestionsStore.getState(), 's1')).toBeNull()

    // Editing another card is also cleared when a session reload shows it was resolved elsewhere.
    useSuggestionsStore.getState().startEditing('s1', saveCard.id)
    expect(editingSuggestionFor(useSuggestionsStore.getState(), 's1')?.card.id).toBe(saveCard.id)

    hostAtMock.mockResolvedValueOnce([
      { ...saveCard, answer: { kind: 'saved', workflowId: 'wf-saved' } },
    ])
    await loadSuggestions('s1', null, { force: true })
    expect(useSuggestionsStore.getState().editing['s1']).toBeUndefined()
  })
})
