import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import {
  conversationMarkdown,
  exportItems,
  type ExportContext,
  type ExportWords,
} from './conversation-markdown'

const words: ExportWords = {
  you: 'You',
  kettu: 'Kettu',
  from: (title) => `From ${title}`,
  fromParent: 'From the parent session',
  attachments: 'Attachments',
  image: (number) => `Image ${number}`,
  audio: 'Audio',
  video: 'Video',
  subagent: 'Sub-agent',
  startedSession: (title) => (title ? `Started ${title}` : 'Started a session'),
  failed: 'Failed',
  cancelled: 'Cancelled',
  separator: ' · ',
}

const context: ExportContext = {
  toolLabel: (entry) =>
    entry.toolKind === 'execute'
      ? { verb: 'Ran', target: entry.rawInput ?? '', kind: 'command' }
      : { verb: 'Read', target: entry.locations[0]?.path ?? '', kind: 'path' },
  sessionTitle: (id) => (id === 'sub-1' ? 'Explore the auth module' : null),
  words,
}

function tool(id: string, changes: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: 'tool',
    toolKind: 'read',
    status: 'completed',
    content: [{ type: 'markdown', markdown: 'SECRET OUTPUT' }],
    locations: [],
    permission: null,
    permissionResult: null,
    ...changes,
  }
}

const entries: ThreadEntry[] = [
  {
    kind: 'user',
    id: 'u1',
    content: [
      { type: 'text', text: 'Why does **login** fail?' },
      { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', blob: 'abc' } },
      {
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: {
            id: 'a1',
            type: 'file',
            name: 'notes.md',
            uri: 'file:///tmp/notes.md',
            mimeType: 'text/markdown',
            size: 12,
            sent: 'embedded',
            thumb: null,
            blob: null,
          },
        },
      },
    ],
  },
  { kind: 'thought', id: 'h1', markdown: 'hidden reasoning', streaming: false },
  tool('t1', { locations: [{ path: 'src/login.ts' }] }),
  tool('t2', { toolKind: 'execute', rawInput: 'pnpm test\n  --filter login', status: 'failed' }),
  { kind: 'subagent', id: 's1', sessionId: 'sub-1' },
  {
    kind: 'agent',
    id: 'a1',
    markdown: 'The token expires:\n\n```ts\nconst ttl = 0\n```',
    attachments: [],
    streaming: false,
  },
  { kind: 'turn_end', id: 'e1', stopReason: 'end_turn', durationMs: 1000 },
  {
    kind: 'user',
    id: 'v1',
    content: [{ type: 'text', text: 'Approved' }],
    approval: true,
  },
]

describe('conversation export', () => {
  it('writes messages as written, steps as one line each and attachments by name', () => {
    const markdown = conversationMarkdown(
      { title: 'Fix login', facts: ['Agent: Claude Code', 'Model: Opus'], agent: 'Claude Code' },
      exportItems(entries, context),
    )
    expect(markdown).toBe(
      [
        '# Fix login',
        '',
        '- Agent: Claude Code',
        '- Model: Opus',
        '',
        '---',
        '',
        '## You',
        '',
        'Why does **login** fail?',
        '',
        'Attachments: `Image 1`, `notes.md`',
        '',
        '## Claude Code',
        '',
        '- Read `src/login.ts`',
        '- Ran `pnpm test --filter login` (Failed)',
        '- Sub-agent · Explore the auth module',
        '',
        'The token expires:',
        '',
        '```ts',
        'const ttl = 0',
        '```',
        '',
      ].join('\n'),
    )
    expect(markdown).not.toContain('SECRET OUTPUT')
    expect(markdown).not.toContain('hidden reasoning')
  })

  it('joins pages read newest first into one thread order', () => {
    const older = exportItems(entries.slice(0, 3), context)
    const newer = exportItems(entries.slice(3), context)
    const head = { title: 'Fix login', facts: [], agent: 'Claude Code' }
    expect(conversationMarkdown(head, [...older, ...newer])).toBe(
      conversationMarkdown(head, exportItems(entries, context)),
    )
  })

  it('keeps a backtick in a name inside its code span', () => {
    const items = exportItems([tool('t', { locations: [{ path: 'a`b.ts' }] })], context)
    expect(items).toEqual([{ kind: 'step', text: 'Read ``a`b.ts``' }])
  })
})
