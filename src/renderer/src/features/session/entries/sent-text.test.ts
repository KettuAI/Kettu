import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAttachedArtifactsPrompt } from '../composer/artifact-attachments'
import type { Chip, ChipContext } from '../composer/chips'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}))

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

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
    createElement(Fragment, null, render ?? children),
  TooltipContent: () => null,
}))

vi.mock(
  '@hugeicons/core-free-icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : prop),
        has: (_target, prop) => prop !== 'then',
      },
    ),
)

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => null,
}))

vi.mock('../markdown/artifact-link', () => ({
  ArtifactLink: ({
    location,
    children,
  }: {
    location: { artifactId: string }
    children?: ReactNode
  }) => createElement('span', { 'data-artifact-ref': location.artifactId }, children),
}))

function stubGlobals() {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  const never = new Promise(() => {})
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    kettu: {
      platform: 'darwin',
      client: 'desktop',
      hostPlatform: () => 'darwin',
      agents: {
        request: vi.fn(() => never),
        onEvent: () => () => {},
        onConnection: () => () => {},
      },
      hosts: {
        request: vi.fn(() => never),
        onChanged: () => () => {},
        onSession: () => () => {},
        status: vi.fn(() => never),
      },
      avatars: { load: vi.fn(() => never) },
      settings: { get: vi.fn(() => never), update: vi.fn(() => never), onChanged: () => () => {} },
      marketplace: { setKeys: vi.fn(() => never), setAgentEnv: vi.fn(() => never) },
      remote: { status: vi.fn(() => never), onChanged: () => () => {} },
      sharing: { status: vi.fn(() => never), onChanged: () => () => {} },
    },
  })
}

const ctx = (extra: Partial<ChipContext> = {}): ChipContext => ({
  commands: ['compact', 'status'],
  skills: ['code-review', 'security-audit'],
  resolve: (token) => {
    if (token === 'auth.ts') return { kind: 'file', path: 'src/auth.ts' }
    if (token === 'terminal:term1234') {
      return { kind: 'terminal', surfaceId: 'term1234', name: 'zsh' }
    }
    return null
  },
  ...extra,
})

function renderChipMarker(chip: Chip, raw: string) {
  return createElement(
    Fragment,
    null,
    createElement(
      'span',
      {
        'data-test-chip': chip.kind,
        'data-test-value':
          chip.kind === 'link'
            ? chip.url
            : chip.kind === 'command' || chip.kind === 'skill'
              ? chip.name
              : chip.label,
        className: 'select-none',
      },
      chip.kind,
    ),
    createElement('span', { className: 'sr-only' }, raw),
  )
}

beforeEach(() => {
  stubGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitUserMessageSegments', () => {
  it('returns verbatim text untouched when there are no fenced code blocks', async () => {
    const { splitUserMessageSegments } = await import('./sent-text-segments')
    const raw = '\n  keep leading and trailing spaces  \n\n'
    expect(splitUserMessageSegments(raw)).toEqual([{ kind: 'text', text: raw, offset: 0 }])
  })

  it('splits explicit backtick and tilde fenced code blocks with language and meta', async () => {
    const { splitUserMessageSegments } = await import('./sent-text-segments')
    const text = [
      'Before block',
      '```sh title="deploy.sh"',
      'echo "hello"',
      '```',
      '',
      'Middle line',
      '',
      '~~~python',
      'print(1)',
      '~~~',
      'After block',
    ].join('\n')

    expect(splitUserMessageSegments(text)).toEqual([
      { kind: 'text', text: 'Before block', offset: 0 },
      {
        kind: 'code',
        language: 'sh',
        meta: 'title="deploy.sh"',
        code: 'echo "hello"',
        raw: '```sh title="deploy.sh"\necho "hello"\n```',
        offset: 'Before block\n'.length,
      },
      { kind: 'text', text: 'Middle line', offset: text.indexOf('Middle line') },
      {
        kind: 'code',
        language: 'python',
        meta: '',
        code: 'print(1)',
        raw: '~~~python\nprint(1)\n~~~',
        offset: text.indexOf('~~~python'),
      },
      { kind: 'text', text: 'After block', offset: text.indexOf('After block') },
    ])
  })

  it('handles longer outer fences wrapping inner triple-backtick fences', async () => {
    const { splitUserMessageSegments } = await import('./sent-text-segments')
    const text = ['````md', '```sh', 'echo nested', '```', '````'].join('\n')
    expect(splitUserMessageSegments(text)).toEqual([
      {
        kind: 'code',
        language: 'md',
        meta: '',
        code: '```sh\necho nested\n```',
        raw: text,
        offset: 0,
      },
    ])
  })

  it('treats unclosed fences and inline backtick runs as verbatim text', async () => {
    const { splitUserMessageSegments } = await import('./sent-text-segments')
    const unclosed = 'Log separator:\n~~~\nsome trailing output'
    expect(splitUserMessageSegments(unclosed)).toEqual([
      { kind: 'text', text: unclosed, offset: 0 },
    ])

    const inline = '```inline```\nnext line'
    expect(splitUserMessageSegments(inline)).toEqual([{ kind: 'text', text: inline, offset: 0 }])
  })

  it('handles empty fenced code blocks and CRLF line endings', async () => {
    const { splitUserMessageSegments } = await import('./sent-text-segments')
    const text = 'Top\r\n```\r\n```\r\nBottom'
    expect(splitUserMessageSegments(text)).toEqual([
      { kind: 'text', text: 'Top', offset: 0 },
      {
        kind: 'code',
        language: '',
        meta: '',
        code: '',
        raw: '```\r\n```',
        offset: 5,
      },
      { kind: 'text', text: 'Bottom', offset: text.indexOf('Bottom') },
    ])
  })
})

describe('SentText rendering', () => {
  async function renderSent(text: string, context: ChipContext = ctx()): Promise<string> {
    const { SentText } = await import('./sent-text')
    return renderToStaticMarkup(
      createElement(SentText, {
        text,
        context,
        renderChip: renderChipMarker,
      }),
    )
  }

  it('preserves pasted shell commands verbatim without strikethrough while linking URLs', async () => {
    const paste = [
      'root@VM-0-2-ubuntu:~# curl -fsSL https://relay.kettu.sh/v1/nodes/install.sh | sudo bash -s -- token',
      'kettu-relay: no relay node release is published yet',
      'root@VM-0-2-ubuntu:~#',
    ].join('\n')

    const html = await renderSent(paste)
    expect(html).not.toContain('<del')
    expect(html.match(/root@VM-0-2-ubuntu:~#/g)).toHaveLength(2)
    expect(html).toContain('data-test-chip="link"')
    expect(html).toContain('data-test-value="https://relay.kettu.sh/v1/nodes/install.sh"')
    expect(html).toContain(
      '<span class="sr-only">https://relay.kettu.sh/v1/nodes/install.sh</span>',
    )
    expect(html).toContain(' | sudo bash -s -- token')
  })

  it('does not apply accidental Markdown formatting to prose, logs, or symbols', async () => {
    const tricky = [
      '# shell comment',
      'foo_bar_baz and *glob* and **not bold**',
      '> quoted line',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '$HOME and $PATH and $$x^2$$',
      '<div class="x">hello</div> and Array<T>',
      ':100: and #123 and ~~not deleted~~',
    ].join('\n')

    const html = await renderSent(tricky)
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('<em')
    expect(html).not.toContain('<strong')
    expect(html).not.toContain('<blockquote')
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<del')
    expect(html).not.toContain('katex')
    expect(html).not.toContain('💯')
    expect(html).not.toContain('<a ')
    expect(html).toContain('# shell comment')
    expect(html).toContain('foo_bar_baz and *glob* and **not bold**')
    expect(html).toContain('&gt; quoted line')
    expect(html).toContain('| a | b |')
    expect(html).toContain('$HOME and $PATH and $$x^2$$')
    expect(html).toContain('&lt;div class=&quot;x&quot;&gt;hello&lt;/div&gt; and Array&lt;T&gt;')
    expect(html).toContain(':100: and #123 and ~~not deleted~~')
  })

  it('renders leading command, multiple skills, mentions, and URL/GitHub chips', async () => {
    const text =
      '/compact check @auth.ts and @terminal:term1234 with /code-review /security-audit see https://example.com/a and github.com/KettuAI/Kettu/issues/2766'
    const html = await renderSent(text)

    expect(html).toContain('data-test-chip="command" data-test-value="compact"')
    expect(html).toContain('data-test-chip="file" data-test-value="auth.ts"')
    expect(html).toContain('data-test-chip="terminal" data-test-value="zsh"')
    expect(html).toContain('data-test-chip="skill" data-test-value="code-review"')
    expect(html).toContain('data-test-chip="skill" data-test-value="security-audit"')
    expect(html).toContain('data-test-chip="link" data-test-value="https://example.com/a"')
    expect(html).toContain(
      'data-test-chip="link" data-test-value="https://github.com/KettuAI/Kettu/issues/2766"',
    )
  })

  it('does not treat a slash command after a code block as a leading command', async () => {
    const text = ['```sh', 'echo hi', '```', '/compact /code-review'].join('\n')
    const html = await renderSent(text)
    expect(html).not.toContain('data-test-chip="command"')
    expect(html).toContain('data-test-chip="skill" data-test-value="code-review"')
  })

  it('renders explicit fenced code blocks verbatim without splitting chips inside them', async () => {
    const text = [
      'Run this:',
      '```sh',
      'root@VM:~# curl https://example.com/a # @auth.ts /code-review',
      '```',
      'Then check @auth.ts',
    ].join('\n')

    const html = await renderSent(text)
    expect(html).toContain('data-user-code=""')
    expect(html).toContain('<span class="block-frame-lang">sh</span>')
    expect(html).toContain(
      '<pre class="ks-user-code__pre"><code>root@VM:~# curl https://example.com/a # @auth.ts /code-review</code></pre>',
    )
    // Only the trailing @auth.ts outside the fence should render as a chip.
    expect(html.match(/data-test-chip="file"/g)).toHaveLength(1)
    expect(html).not.toContain('data-test-chip="link"')
    expect(html).not.toContain('data-test-chip="skill"')
  })
})

describe('UserContentView integration', () => {
  it('renders user messages synchronously with attached artifacts, chips, and Clamp', async () => {
    const { UserContentView } = await import('./user-content')
    const prompt = formatAttachedArtifactsPrompt(
      'root@VM-0-2-ubuntu:~# curl -fsSL https://relay.kettu.sh/v1/nodes/install.sh | sudo bash\nroot@VM-0-2-ubuntu:~#',
      [{ id: 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3', title: 'Design Spec', kind: 'document' }],
    )
    const html = renderToStaticMarkup(
      createElement(UserContentView, {
        content: [{ type: 'text', text: prompt }],
      }),
    )

    expect(html).toContain('ks-user-text')
    expect(html).not.toContain('<del')
    expect(html.match(/root@VM-0-2-ubuntu:~#/g)).toHaveLength(2)
    expect(html).toContain('data-chip="link"')
    expect(html).toContain(
      '<span aria-hidden="true" class="sr-only">https://relay.kettu.sh/v1/nodes/install.sh</span>',
    )
    expect(html).toContain('Design Spec')
    expect(html).toContain('data-selectable=""')
  })
})
