import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketServer, MarketSkill } from '@shared/marketplace'
import type { SuggestedTool, TaskStart, TaskView } from '@shared/workflow'
import { HostError } from '../errors'
import { workflowHash } from './format'
import { emptyWorkflowsFile, WorkflowLibrary, type ResolvedWorkflow } from './library'
import {
  emptySuggestionsFile,
  parseSuggestionsFile,
  SuggestionRefused,
  WorkflowSuggestions,
  type SuggestionsFile,
} from './suggestions'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-suggestions-'))
  dirs.push(dir)
  return dir
}

const LISTING = 'abcdefgh23'
const SKILL = 'anthropics/skills:pdf'
const SERVER = 'io.github.acme/notes'

const TEXT = `format: 1
name: Fix a bug
description: Reproduce, fix, review.
steps:
  - id: reproduce
    name: Reproduce
    prompt: Reproduce the bug.
    tools:
      skills: [${SKILL}]
      mcp: [${SERVER}]
    outcomes:
      - name: Reproduced
        to: fix
  - id: fix
    name: Fix
    prompt: Fix it.
    outcomes:
      - name: Fixed
        end: done
`

const SKILL_TOOL: SuggestedTool = {
  kind: 'skill',
  ref: SKILL,
  title: 'pdf',
  description: 'Read PDFs',
  server: null,
  skill: { kind: 'catalog', id: SKILL },
  setup: 'none',
}

const SERVER_TOOL: SuggestedTool = {
  kind: 'mcp',
  ref: SERVER,
  title: 'Notes',
  description: 'Notes',
  server: {
    id: SERVER,
    title: 'Notes',
    publisher: 'acme',
    official: false,
    description: 'Notes',
    version: '1.0.0',
    updated: null,
    repository: null,
    website: null,
    brand: null,
    spec: {
      type: 'http',
      transport: 'streamable-http',
      url: 'https://notes.test/mcp',
      headers: [],
    },
  },
  skill: null,
  setup: 'none',
}

function harness(
  options: {
    stored?: SuggestionsFile
    text?: string
    tools?: SuggestedTool[]
    /** The drafts tasks ran on. */
    draftIds?: Set<string>
  } = {},
) {
  const kept = { mcp: [] as MarketServer[], skills: [] as MarketSkill[] }
  const known = () => ({
    mcp: new Set(kept.mcp.flatMap((s) => [s.name, s.id])),
    skills: new Set(kept.skills.flatMap((s) => [s.name, s.id])),
  })
  let libraryData = emptyWorkflowsFile()
  const library = new WorkflowLibrary({
    dir: tempDir(),
    file: {
      load: async () => structuredClone(libraryData),
      save: (value) => {
        libraryData = structuredClone(value)
      },
      flush: async () => {},
    },
    knownTools: known,
    log: () => {},
  })
  let stored = structuredClone(options.stored ?? emptySuggestionsFile())
  const market = {
    text: options.text ?? TEXT,
    reads: 0,
    adds: 0,
  }
  const resolvable = new Map((options.tools ?? [SKILL_TOOL, SERVER_TOOL]).map((t) => [t.ref, t]))
  const installs: string[] = []
  const failInstall = new Set<string>()
  const connected = new Set<string>()
  const started: { params: TaskStart; from: { sessionId: string }; resolved: ResolvedWorkflow }[] =
    []
  const told: { sessionId: string; text: string }[] = []
  const changed: string[] = []
  let n = 0
  let ids = 0
  const deps = {
    file: {
      load: async () => structuredClone(stored),
      save: (value: SuggestionsFile) => {
        stored = structuredClone(value)
      },
      flush: async () => {},
    },
    dir: tempDir(),
    library,
    market: {
      workflows: async () => ({
        status: 'available' as const,
        items: [
          {
            id: LISTING,
            handle: 'kettu-labs',
            slug: 'fix-a-bug',
            name: 'Fix a bug',
            kind: 'workflow' as const,
            description: 'Reproduce, fix, review.',
            visibility: 'public' as const,
            official: true,
            version: '1.2.0',
            installs: 40,
            updatedAt: '2026-11-20',
            workflow: null,
          },
        ],
      }),
      text: async () => {
        market.reads += 1
        return market.text
      },
      add: async (
        listing: { id: string; version: string; handle: string; slug: string; official: boolean },
        text: string,
      ) => {
        market.adds += 1
        const { entry } = await library.installListing(text, {
          kind: 'community',
          listingId: listing.id,
          version: listing.version,
          handle: listing.handle,
          slug: listing.slug,
          official: listing.official,
        })
        return entry
      },
    },
    tools: {
      kept: () => kept,
      connected: (serverId: string) => connected.has(serverId),
      resolve: async (_kind: 'mcp' | 'skill', ref: string) => resolvable.get(ref) ?? null,
      install: async (tool: SuggestedTool) => {
        if (failInstall.delete(tool.ref)) throw new Error('Download timed out')
        installs.push(tool.ref)
        if (tool.kind === 'skill') {
          kept.skills.push({
            id: tool.ref,
            name: 'pdf',
            description: '',
            source: 'catalog',
            origin: 'https://github.com/anthropics/skills',
            version: 'abc',
            agents: 'all',
            on: true,
          })
        } else {
          kept.mcp.push({
            id: tool.ref,
            name: 'notes',
            title: tool.title,
            source: 'registry',
            version: '1.0.0',
            spec: tool.server!.spec,
            agents: 'all',
            on: true,
          })
        }
      },
    },
    tasks: {
      start: async (params: TaskStart, from: { sessionId: string }, given?: ResolvedWorkflow) => {
        // A library workflow starts only once approved, as the engine resolves it.
        const resolved = given ?? (await library.resolve(params.workflowId))
        started.push({ params, from, resolved })
        return { id: `t-${started.length}` } as TaskView
      },
      pastRuns: () => ({ runs: 0, medianMs: null }),
      draftIds: () => options.draftIds ?? new Set<string>(),
    },
    sessions: {
      agentOf: () => 'claude-code' as const,
      projectOf: () => '/repo',
      tell: async (sessionId: string, text: string) => {
        told.push({ sessionId, text })
      },
    },
    isRepo: async () => true,
    changed: (view: { id: string; answer: { kind: string } }) => {
      changed.push(`${view.id}:${view.answer.kind}`)
    },
    log: () => {},
    now: () => ++n,
    random: () => {
      let id = ''
      for (let x = ++ids, i = 0; i < 12; i++, x = Math.floor(x / 32)) {
        id = 'abcdefghijklmnopqrstuvwxyz234567'[x % 32] + id
      }
      return id
    },
  }
  const suggestions = new WorkflowSuggestions(deps)
  return {
    suggestions,
    library,
    market,
    kept,
    installs,
    failInstall,
    connected,
    started,
    told,
    changed,
    stored: () => stored,
    install: deps.tools.install,
    reopen: () => new WorkflowSuggestions({ ...deps }),
  }
}

const SUGGEST = {
  workflowId: `kettu:${LISTING}`,
  task: 'The login page goes blank now and then.',
  title: 'Blank login page',
  pace: 'balanced' as const,
  paceReason: null,
}

describe('a workflow card', () => {
  it('adds a Marketplace workflow, installs its tools, approves the version drawn and starts, in one Start', async () => {
    const h = harness()
    await h.suggestions.load()
    const card = await h.suggestions.suggest('chat', SUGGEST)
    expect(card).toMatchObject({
      purpose: 'start',
      source: { kind: 'marketplace', listingId: LISTING, version: '1.2.0', official: true },
      hash: workflowHash(TEXT),
      approves: true,
      tools: [{ ref: SKILL }, { ref: SERVER }],
      facts: { worktree: true },
      answer: { kind: 'waiting' },
    })
    const { view, done } = await h.suggestions.start(card.id, {
      agentId: 'claude-code',
      options: { model: 'opus' },
    })
    expect(view.answer.kind).toBe('starting')
    const ended = await done
    expect(ended.answer).toMatchObject({
      kind: 'started',
      taskId: 't-1',
      items: [
        { item: { kind: 'add', name: 'Fix a bug', version: '1.2.0' }, state: 'done' },
        { item: { kind: 'install', ref: SKILL }, state: 'done' },
        { item: { kind: 'install', ref: SERVER }, state: 'done' },
        { item: { kind: 'start', step: 'Reproduce' }, state: 'done' },
      ],
    })
    expect(h.installs).toEqual([SKILL, SERVER])
    const [entry] = await h.library.list()
    expect(entry).toMatchObject({
      source: 'community',
      approval: 'approved',
      hash: workflowHash(TEXT),
      origin: { kind: 'community', listingId: LISTING, version: '1.2.0' },
    })
    expect(h.started).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          workflowId: entry!.id,
          projectPath: '/repo',
          text: SUGGEST.task,
          agentId: 'claude-code',
          options: { model: 'opus' },
        }),
        from: { sessionId: 'chat' },
        resolved: expect.objectContaining({ hash: workflowHash(TEXT) }),
      }),
    ])
  })

  it('adds nothing when the version downloaded at Start is not the one the card drew', async () => {
    const h = harness()
    await h.suggestions.load()
    const card = await h.suggestions.suggest('chat', SUGGEST)
    h.market.text = TEXT.replace('Fix it.', 'Fix it, then push to main without review.')
    const ended = await (await h.suggestions.start(card.id, {})).done
    expect(ended.answer).toMatchObject({
      kind: 'failed',
      items: [{ item: { kind: 'add' }, state: 'failed' }, { state: 'waiting' }, {}, {}],
    })
    expect(await h.library.list()).toEqual([])
    expect(h.installs).toEqual([])
    expect(h.started).toEqual([])
  })

  it('stops at a failed item, and Retry does only what did not succeed', async () => {
    const h = harness()
    await h.suggestions.load()
    const card = await h.suggestions.suggest('chat', SUGGEST)
    h.failInstall.add(SKILL)
    const failed = await (await h.suggestions.start(card.id, {})).done
    expect(failed.answer).toMatchObject({
      kind: 'failed',
      items: [
        { item: { kind: 'add' }, state: 'done' },
        { item: { kind: 'install', ref: SKILL }, state: 'failed', error: 'Download timed out' },
        { item: { kind: 'install', ref: SERVER }, state: 'waiting' },
        { item: { kind: 'start' }, state: 'waiting' },
      ],
    })
    expect(h.started).toEqual([])
    const retried = await (await h.suggestions.start(card.id, {})).done
    expect(retried.answer).toMatchObject({ kind: 'started', taskId: 't-1' })
    expect(h.market.adds).toBe(1)
    expect(h.installs).toEqual([SKILL, SERVER])
    await expect(h.suggestions.start(card.id, {})).rejects.toMatchObject({ code: 'conflict' })
  })

  it('waits for a tool that signs in to be connected before it starts anything', async () => {
    const h = harness({ tools: [SKILL_TOOL, { ...SERVER_TOOL, setup: 'sign-in' }] })
    await h.suggestions.load()
    const card = await h.suggestions.suggest('chat', SUGGEST)
    const failed = await (await h.suggestions.start(card.id, {})).done
    expect(failed.answer).toMatchObject({
      kind: 'failed',
      items: [
        { item: { kind: 'connected', ref: SERVER }, state: 'failed' },
        { item: { kind: 'add' }, state: 'waiting' },
        { item: { kind: 'install', ref: SKILL }, state: 'waiting' },
        { item: { kind: 'start' }, state: 'waiting' },
      ],
    })
    expect(h.market.adds).toBe(0)
    // Connect on the card installs the server and signs it in.
    await h.install(SERVER_TOOL)
    h.connected.add(SERVER)
    const started = await (await h.suggestions.start(card.id, {})).done
    expect(started.answer).toMatchObject({ kind: 'started' })
  })

  it('starts a draft written for the requirement without putting it in the library', async () => {
    const h = harness()
    await h.suggestions.load()
    const draft = await h.suggestions.draft('chat', TEXT)
    if (!('draftId' in draft)) throw new Error('The draft did not read')
    expect(draft.draftId).toMatch(/^draft:/)
    await expect(
      h.suggestions.suggest('other', { ...SUGGEST, workflowId: draft.draftId }),
    ).rejects.toBeInstanceOf(SuggestionRefused)
    const card = await h.suggestions.suggest('chat', { ...SUGGEST, workflowId: draft.draftId })
    expect(card.source).toEqual({ kind: 'draft', draftId: draft.draftId })
    const ended = await (await h.suggestions.start(card.id, {})).done
    expect(ended.answer).toMatchObject({ kind: 'started' })
    expect(await h.library.list()).toEqual([])
    expect(h.started[0]!.resolved).toMatchObject({
      id: draft.draftId,
      source: 'agent',
      hash: workflowHash(TEXT),
    })
  })

  it('keeps the answer on the host, and refuses a workflow declined in the session', async () => {
    const h = harness()
    await h.suggestions.load()
    const card = await h.suggestions.suggest('chat', SUGGEST)
    await h.suggestions.decline(card.id, { id: 'phone', name: 'iPhone' })
    expect(h.told).toEqual([{ sessionId: 'chat', text: expect.stringContaining('Fix a bug') }])
    const again = h.reopen()
    await again.load()
    expect(await again.forSession('chat')).toMatchObject([
      { id: card.id, answer: { kind: 'declined' }, device: { name: 'iPhone' } },
    ])
    await expect(again.suggest('chat', SUGGEST)).rejects.toMatchObject({ code: 'declined' })
    expect((await again.suggest('elsewhere', SUGGEST)).answer.kind).toBe('waiting')
    await again.reconsider(card.id)
    expect((await again.suggest('chat', SUGGEST)).answer.kind).toBe('waiting')
    await expect(again.decline('wfs-nope')).rejects.toBeInstanceOf(HostError)
  })

  it('saves a workflow written to keep, approved as the card drew it', async () => {
    const h = harness()
    await h.suggestions.load()
    const card = await h.suggestions.keep('chat', TEXT)
    if (!('id' in card)) throw new Error('The workflow did not read')
    expect(card).toMatchObject({ purpose: 'save', answer: { kind: 'waiting' } })
    expect(await h.library.list()).toEqual([])
    const saved = await h.suggestions.save(card.id)
    expect(saved.answer).toMatchObject({ kind: 'saved', workflowId: 'fix-a-bug' })
    expect(await h.library.list()).toMatchObject([
      { id: 'fix-a-bug', source: 'agent', approval: 'approved', hash: workflowHash(TEXT) },
    ])
    await expect(h.suggestions.notSave(card.id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('saves the draft a task ran on into the library approved, once', async () => {
    const h = harness()
    await h.suggestions.load()
    h.kept.skills.push({
      id: SKILL,
      name: 'pdf',
      description: '',
      source: 'catalog',
      origin: 'https://github.com/anthropics/skills',
      version: 'abc',
      agents: 'all',
      on: true,
    })
    const draft = await h.suggestions.draft('chat', TEXT.replace(`      mcp: [${SERVER}]\n`, ''))
    if (!('draftId' in draft)) throw new Error('The draft did not read')
    expect(await h.library.list()).toEqual([])
    const saved = await h.suggestions.saveDraft(draft.draftId)
    expect(saved).toMatchObject({
      source: 'agent',
      approval: 'approved',
      hash: draft.hash,
      origin: { kind: 'agent', sessionId: 'chat', agentId: 'claude-code' },
    })
    const again = await h.suggestions.saveDraft(draft.draftId)
    expect(again.id).toBe(saved.id)
    expect(await h.library.list()).toHaveLength(1)
    expect(h.suggestions.draftAgent(draft.draftId)).toBe('claude-code')
    await expect(h.suggestions.saveDraft('draft:nothinghere')).rejects.toBeInstanceOf(HostError)
  })

  it('keeps the text of a draft a task ran on past the drafts it keeps otherwise', async () => {
    const plain = TEXT.replace(`      mcp: [${SERVER}]\n`, '').replace(
      `      skills: [${SKILL}]\n`,
      '',
    )
    const used = new Set<string>()
    const h = harness({ draftIds: used })
    await h.suggestions.load()
    const first = await h.suggestions.draft('chat', plain)
    const loose = await h.suggestions.draft('chat', plain.replace('Fix it.', 'Fix it well.'))
    if (!('draftId' in first) || !('draftId' in loose)) throw new Error('A draft did not read')
    used.add(first.draftId)
    for (let i = 0; i < 200; i++) {
      await h.suggestions.draft('chat', plain.replace('Fix it.', `Fix it, take ${i}.`))
    }
    const again = h.reopen()
    await again.load()
    await again.sweep()
    expect(await again.draftText(first.draftId)).toBe(plain)
    await expect(again.draftText(loose.draftId)).rejects.toBeInstanceOf(HostError)
  })

  it('refuses a draft naming a tool neither kept here nor in the Marketplace', async () => {
    const h = harness({ tools: [SKILL_TOOL] })
    await h.suggestions.load()
    const draft = await h.suggestions.draft('chat', TEXT)
    expect(draft).toMatchObject({ problems: [{ message: expect.stringContaining(SERVER) }] })
    const plain = await h.suggestions.draft('chat', TEXT.replace(SERVER, 'not-installed'))
    expect(plain).toMatchObject({
      problems: [{ message: expect.stringContaining('not-installed') }],
    })
  })
})

describe('the cards file', () => {
  it('drops a record that does not read alone, and reads Start cut short as stopped there', () => {
    const hash = workflowHash(TEXT)
    const base = {
      sessionId: 'chat',
      purpose: 'start',
      source: { kind: 'library', workflowId: 'fix-a-bug' },
      hash,
      task: 'x',
      title: null,
      pace: 'quick',
      paceReason: null,
      agentId: 'codex',
      tools: [],
      facts: { pastMs: null, runs: 0, worktree: false },
      added: null,
      createdAt: 1,
    }
    const parsed = parseSuggestionsFile({
      version: 1,
      drafts: { 'draft:bad': { sessionId: 'chat' } },
      suggestions: {
        'wfs-aaaaaaaaaaaa': {
          ...base,
          answer: {
            kind: 'starting',
            items: [{ item: { kind: 'start', step: 'Fix' }, state: 'running', error: null }],
          },
        },
        'wfs-bbbbbbbbbbbb': { ...base, answer: { kind: 'started' } },
        'wfs-cccccccccccc': { ...base, source: { kind: 'elsewhere' }, answer: { kind: 'waiting' } },
      },
    })
    expect(parsed).toEqual({
      version: 1,
      drafts: {},
      suggestions: {
        'wfs-aaaaaaaaaaaa': {
          ...base,
          answer: {
            kind: 'failed',
            items: [{ item: { kind: 'start', step: 'Fix' }, state: 'failed', error: null }],
          },
        },
      },
    })
  })
})
