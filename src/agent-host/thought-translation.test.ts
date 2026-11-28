import { describe, expect, it, vi } from 'vitest'
import { THOUGHT_TRANSLATE_MAX_CHARS } from '@shared/agent-host'
import type { AgentConnection } from './connection'
import {
  cleanThoughtTranslation,
  resolveThoughtTranslationTarget,
  THOUGHT_TRANSLATE_OUTPUT_CHARS,
  thoughtTranslationPrompt,
  translateThoughtSummary,
} from './thought-translation'

function makeRuntime(overrides: Partial<AgentConnection> = {}): {
  runtime: { connection: AgentConnection }
  newSession: ReturnType<typeof vi.fn>
  setConfigOption: ReturnType<typeof vi.fn>
  collect: ReturnType<typeof vi.fn>
  removeHidden: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  const newSession = vi.fn().mockResolvedValue({
    sessionId: 'hidden-1',
    config: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        value: 'claude-sonnet-4',
        choices: [
          { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
          { value: 'claude-haiku-4', name: 'Claude Haiku 4' },
        ],
      },
    ],
  })
  const setConfigOption = vi.fn().mockResolvedValue(undefined)
  const collect = vi.fn().mockResolvedValue(['<translation>分析问题根因。</translation>'])
  const removeHidden = vi.fn().mockResolvedValue(undefined)
  const cancel = vi.fn().mockResolvedValue(undefined)
  const connection = {
    hiddenSessions: true,
    newSession,
    setConfigOption,
    collect,
    removeHidden,
    cancel,
    ...overrides,
  } as unknown as AgentConnection
  return {
    runtime: { connection },
    newSession,
    setConfigOption,
    collect,
    removeHidden,
    cancel,
  }
}

describe('thoughtTranslationPrompt', () => {
  it('names the target language and wraps the displayed thinking text safely', () => {
    const prompt = thoughtTranslationPrompt(
      'Check `src/main/ipc.ts` before editing.\n\n```ts\nconst x = 1\n```',
      'zh-CN',
    )
    expect(prompt).toContain('Simplified Chinese (BCP 47 tag zh-CN)')
    expect(prompt).toContain('<thinking_summary>')
    expect(prompt).toContain('Check `src/main/ipc.ts` before editing.')
    expect(prompt).toContain('</thinking_summary>')
    expect(prompt).toContain('<translation>')
    expect(prompt).toContain('do not use any tools')
  })

  it('supports arbitrary BCP 47 language tags and clips overly long text', () => {
    const prompt = thoughtTranslationPrompt('a'.repeat(THOUGHT_TRANSLATE_MAX_CHARS + 50), 'pt-BR')
    expect(prompt).toContain('BCP 47 tag pt-BR')
    const start = prompt.indexOf('<thinking_summary>\n') + '<thinking_summary>\n'.length
    const end = prompt.indexOf('\n</thinking_summary>')
    expect(prompt.slice(start, end)).toHaveLength(THOUGHT_TRANSLATE_MAX_CHARS)
  })
})

describe('cleanThoughtTranslation', () => {
  it('extracts text inside <translation> tags and preserves inner fenced code blocks', () => {
    const reply = [
      'Sure, here is the translation:',
      '<translation>',
      '先检查配置文件：',
      '',
      '```ts',
      'export const answer = 42',
      '```',
      '',
      '然后运行 `pnpm test`。',
      '</translation>',
      'Hope this helps!',
    ].join('\n')
    expect(cleanThoughtTranslation(reply)).toBe(
      [
        '先检查配置文件：',
        '',
        '```ts',
        'export const answer = 42',
        '```',
        '',
        '然后运行 `pnpm test`。',
      ].join('\n'),
    )
  })

  it('unwraps a single outer code fence when tags are absent and no inner fences exist', () => {
    expect(cleanThoughtTranslation('```markdown\n**第一步**：读取日志。\n```')).toBe(
      '**第一步**：读取日志。',
    )
  })

  it('keeps unfenced replies containing code blocks intact', () => {
    const raw = '步骤：\n\n```sh\npnpm lint\n```\n\n完成。'
    expect(cleanThoughtTranslation(raw)).toBe(raw)
  })

  it('returns null for empty replies or empty translation tags', () => {
    expect(cleanThoughtTranslation('')).toBeNull()
    expect(cleanThoughtTranslation('   \n  ')).toBeNull()
    expect(cleanThoughtTranslation('<translation>\n</translation>')).toBeNull()
  })

  it('collapses excessive blank lines and caps output length', () => {
    expect(cleanThoughtTranslation('<translation>A\n\n\n\nB</translation>')).toBe('A\n\nB')
    const longReply = `<translation>${'x'.repeat(THOUGHT_TRANSLATE_OUTPUT_CHARS + 100)}</translation>`
    expect(Array.from(cleanThoughtTranslation(longReply)!).length).toBe(
      THOUGHT_TRANSLATE_OUTPUT_CHARS,
    )
  })
})

describe('translateThoughtSummary', () => {
  it('reuses a hidden lightweight session, picks the small model, and removes it afterwards', async () => {
    const { runtime, newSession, setConfigOption, collect, removeHidden } = makeRuntime()
    const translated = await translateThoughtSummary(runtime, {
      dir: '/tmp/reports',
      text: 'Investigating the cache key mismatch.',
      language: 'zh-CN',
      model: { small: true, model: 'claude-sonnet-4' },
      log: vi.fn(),
    })

    expect(translated).toBe('分析问题根因。')
    expect(newSession).toHaveBeenCalledWith('/tmp/reports', { hidden: 'titles' })
    expect(setConfigOption).toHaveBeenCalledWith('hidden-1', 'model', 'claude-haiku-4')
    expect(collect).toHaveBeenCalledTimes(1)
    expect(collect.mock.calls[0]![0]).toBe('hidden-1')
    expect(collect.mock.calls[0]![1]).toContain('Investigating the cache key mismatch.')
    expect(collect.mock.calls[0]![1]).toContain('zh-CN')
    expect(removeHidden).toHaveBeenCalledWith('hidden-1', expect.any(Function))
  })

  it('rejects cleanly when the agent cannot remove hidden sessions', async () => {
    const { runtime, newSession } = makeRuntime({ hiddenSessions: false })
    await expect(
      translateThoughtSummary(runtime, {
        dir: '/tmp/reports',
        text: 'Inspecting logs.',
        language: 'zh-CN',
        model: { small: true, model: null },
        log: vi.fn(),
      }),
    ).rejects.toThrow(/hidden sessions cannot be removed/i)
    expect(newSession).not.toHaveBeenCalled()
  })

  it('rejects when the reply holds no translation and still removes the hidden session', async () => {
    const { runtime, removeHidden } = makeRuntime({
      collect: vi.fn().mockResolvedValue(['<translation>   </translation>']),
    })
    await expect(
      translateThoughtSummary(runtime, {
        dir: '/tmp/reports',
        text: 'Inspecting logs.',
        language: 'zh-CN',
        model: { small: true, model: null },
        log: vi.fn(),
      }),
    ).rejects.toThrow(/held no translation/i)
    expect(removeHidden).toHaveBeenCalledWith('hidden-1', expect.any(Function))
  })
})

describe('resolveThoughtTranslationTarget', () => {
  it('uses the session agent and lightweight model setting when hidden sessions are supported', () => {
    expect(
      resolveThoughtTranslationTarget({
        lightModel: { mode: 'small' },
        sessionAgentId: 'claude-code',
        sessionAgentAvailable: true,
        sessionModel: 'claude-sonnet-4',
        preferredAgentId: 'codex',
        fallbackLightAgentId: 'opencode',
      }),
    ).toEqual({
      agentId: 'claude-code',
      model: { small: true, model: 'claude-sonnet-4' },
    })
  })

  it('falls back to a hidden-capable agent without leaking the session model when needed', () => {
    expect(
      resolveThoughtTranslationTarget({
        lightModel: { mode: 'small' },
        sessionAgentId: 'antigravity',
        sessionAgentAvailable: true,
        sessionModel: 'gemini-2.5-pro',
        preferredAgentId: 'codex',
        fallbackLightAgentId: 'opencode',
      }),
    ).toEqual({
      agentId: 'codex',
      model: { small: true, model: null },
    })

    expect(
      resolveThoughtTranslationTarget({
        lightModel: { mode: 'session' },
        sessionAgentId: 'antigravity',
        sessionAgentAvailable: true,
        sessionModel: 'gemini-2.5-pro',
        preferredAgentId: 'gemini',
        fallbackLightAgentId: 'opencode',
      }),
    ).toEqual({
      agentId: 'opencode',
      model: { small: false, model: null },
    })
  })

  it('always honors a pinned lightweight model and returns null when no agent is available', () => {
    expect(
      resolveThoughtTranslationTarget({
        lightModel: { mode: 'pinned', agentId: 'codex', model: 'gpt-5-mini' },
        sessionAgentId: 'antigravity',
        sessionAgentAvailable: false,
        sessionModel: null,
        preferredAgentId: null,
        fallbackLightAgentId: null,
      }),
    ).toEqual({
      agentId: 'codex',
      model: { small: false, model: 'gpt-5-mini', pinned: true },
    })

    expect(
      resolveThoughtTranslationTarget({
        lightModel: { mode: 'small' },
        sessionAgentId: 'claude-code',
        sessionAgentAvailable: false,
        sessionModel: null,
        preferredAgentId: null,
        fallbackLightAgentId: null,
      }),
    ).toBeNull()
  })
})
