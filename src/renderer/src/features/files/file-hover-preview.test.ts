import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent } from '@shared/files'
import enFiles from '@shared/locales/en/files.json'
import zhFiles from '@shared/locales/zh-CN/files.json'
import {
  clearFilePreviewCache,
  FILE_PREVIEW_CACHE_TTL_MS,
  getCachedFilePreview,
  previewSourceKey,
  readFilePreview,
  type FilePreviewSource,
} from './file-hover-cache'
import { previewTokenStyle } from './file-hover-highlight'
import {
  computePreviewScrollTop,
  FILE_HOVER_MAX_CHARS,
  FILE_HOVER_MAX_LINES,
  formatFileTarget,
  formatLineRange,
  languageFromFilePath,
  normalizeLineRange,
  parseLineRangeText,
  shouldReadAsText,
  slicePreviewText,
} from './file-hover-model'

describe('file-hover-model line range and target formatting', () => {
  it('normalizes single lines and ranges, rejecting non-positive or inverted ends', () => {
    expect(normalizeLineRange(null)).toBeNull()
    expect(normalizeLineRange(0)).toBeNull()
    expect(normalizeLineRange(-5)).toBeNull()
    expect(normalizeLineRange(12)).toEqual({ start: 12, end: 12 })
    expect(normalizeLineRange(12, 20)).toEqual({ start: 12, end: 20 })
    expect(normalizeLineRange(12, 8)).toEqual({ start: 12, end: 12 })
  })

  it('parses chip line ranges with hyphen or en-dash', () => {
    expect(parseLineRangeText(null)).toBeNull()
    expect(parseLineRangeText('')).toBeNull()
    expect(parseLineRangeText('42')).toEqual({ start: 42, end: 42 })
    expect(parseLineRangeText('41-44')).toEqual({ start: 41, end: 44 })
    expect(parseLineRangeText('41\u201344')).toEqual({ start: 41, end: 44 })
    expect(parseLineRangeText('not-a-range')).toBeNull()
  })

  it('formats line ranges and file targets cleanly', () => {
    expect(formatLineRange(null)).toBeNull()
    expect(formatLineRange({ start: 7, end: 7 })).toBe('7')
    expect(formatLineRange({ start: 7, end: 12 })).toBe('7\u201312')
    expect(formatFileTarget('src/app.ts', null)).toBe('src/app.ts')
    expect(formatFileTarget('src/app.ts', { start: 7, end: 7 })).toBe('src/app.ts:7')
    expect(formatFileTarget('src/app.ts', { start: 7, end: 12 })).toBe('src/app.ts:7\u201312')
  })

  it('maps file paths to Shiki languages and detects SVG line-target text mode', () => {
    expect(languageFromFilePath('src/index.ts')).toBe('typescript')
    expect(languageFromFilePath('src/App.tsx')).toBe('tsx')
    expect(languageFromFilePath('scripts/check_docs.py')).toBe('python')
    expect(languageFromFilePath('Dockerfile')).toBe('dockerfile')
    expect(languageFromFilePath('.env.production')).toBe('dotenv')
    expect(languageFromFilePath('README.unknownext')).toBe('text')
    expect(shouldReadAsText('assets/logo.svg', null)).toBe(false)
    expect(shouldReadAsText('assets/logo.svg', { start: 5, end: 5 })).toBe(true)
    expect(shouldReadAsText('assets/photo.png', { start: 5, end: 5 })).toBe(false)
  })
})

describe('slicePreviewText and computePreviewScrollTop', () => {
  it('renders small files completely without trailing ghost lines', () => {
    const slice = slicePreviewText('line 1\r\nline 2\r\nline 3\r\n', { start: 2, end: 2 })
    expect(slice.empty).toBe(false)
    expect(slice.totalLines).toBe(3)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(3)
    expect(slice.truncated).toBe(false)
    expect(slice.truncatedBefore).toBe(false)
    expect(slice.truncatedAfter).toBe(false)
    expect(slice.highlight).toEqual({ start: 2, end: 2 })
    expect(slice.lines.map((l) => l.text)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('handles empty files cleanly', () => {
    const slice = slicePreviewText('', { start: 5, end: 10 })
    expect(slice.empty).toBe(true)
    expect(slice.lines).toEqual([])
    expect(slice.totalLines).toBe(0)
    expect(slice.highlight).toBeNull()
  })

  it('truncates large files from line 1 when no target line is given', () => {
    const big = Array.from({ length: 1_000 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
    const slice = slicePreviewText(big, null)
    expect(slice.totalLines).toBe(1_000)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(FILE_HOVER_MAX_LINES)
    expect(slice.truncated).toBe(true)
    expect(slice.truncatedBefore).toBe(false)
    expect(slice.truncatedAfter).toBe(true)
  })

  it('centers the preview window around a distant target line range in a large file', () => {
    const big = Array.from({ length: 1_500 }, (_, i) => `row ${i + 1}`).join('\n')
    const slice = slicePreviewText(big, { start: 850, end: 865 })
    expect(slice.totalLines).toBe(1_500)
    expect(slice.lines.length).toBe(FILE_HOVER_MAX_LINES)
    expect(slice.startLine).toBe(730)
    expect(slice.endLine).toBe(1129)
    expect(slice.highlight).toEqual({ start: 850, end: 865 })
    expect(slice.truncated).toBe(true)
    expect(slice.truncatedBefore).toBe(true)
    expect(slice.truncatedAfter).toBe(true)
    expect(slice.lines.some((l) => l.number === 850)).toBe(true)
    expect(slice.lines.some((l) => l.number === 865)).toBe(true)
  })

  it('enforces character budgets and clips very long minified lines while keeping the target line visible', () => {
    const hugeLines = Array.from({ length: 100 }, (_, i) => `${i + 1}: ${'x'.repeat(2_500)}`).join(
      '\n',
    )
    const slice = slicePreviewText(hugeLines, { start: 60, end: 60 })
    expect(slice.truncated).toBe(true)
    expect(slice.lines.some((l) => l.number === 60)).toBe(true)
    expect(slice.lines.every((l) => l.lineTruncated)).toBe(true)
    const totalRenderedChars = slice.lines.reduce((sum, line) => sum + line.text.length, 0)
    expect(totalRenderedChars).toBeLessThanOrEqual(FILE_HOVER_MAX_CHARS + 2_005)
  })

  it('clamps out-of-bounds target lines to the end of the file', () => {
    const slice = slicePreviewText('a\nb\nc', { start: 50, end: 80 })
    expect(slice.highlight).toEqual({ start: 3, end: 3 })
  })

  it('computes centered scroll offsets clamped within the preview scroll container', () => {
    expect(
      computePreviewScrollTop({
        rowOffsetTop: 100,
        rowHeight: 20,
        containerHeight: 300,
        scrollHeight: 200,
      }),
    ).toBe(0)

    expect(
      computePreviewScrollTop({
        rowOffsetTop: 400,
        rowHeight: 20,
        highlightHeight: 60,
        containerHeight: 300,
        scrollHeight: 1200,
      }),
    ).toBe(280)

    expect(
      computePreviewScrollTop({
        rowOffsetTop: 20,
        rowHeight: 20,
        containerHeight: 300,
        scrollHeight: 1200,
      }),
    ).toBe(0)

    expect(
      computePreviewScrollTop({
        rowOffsetTop: 1180,
        rowHeight: 20,
        containerHeight: 300,
        scrollHeight: 1200,
      }),
    ).toBe(900)
  })
})

describe('file-hover-cache deduplication and TTL behavior', () => {
  beforeEach(() => {
    clearFilePreviewCache()
  })

  afterEach(() => {
    clearFilePreviewCache()
  })

  it('caches reads within TTL, deduplicates concurrent reads, and refetches after expiry', async () => {
    let clock = 1_000
    const source: FilePreviewSource = {
      kind: 'project',
      projectPath: '/Users/dev/app',
      path: 'src/index.ts',
    }
    const sample: FileContent = {
      kind: 'text',
      path: 'src/index.ts',
      size: 16,
      text: 'export const a = 1',
      version: 'v1',
      editable: true,
    }
    let resolveFetch!: (value: FileContent) => void
    const fetcher = vi.fn(
      () =>
        new Promise<FileContent>((resolve) => {
          resolveFetch = resolve
        }),
    )

    // Two concurrent hovers trigger only one host read.
    const p1 = readFilePreview(source, { fetcher, now: () => clock })
    const p2 = readFilePreview(source, { fetcher, now: () => clock })
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolveFetch(sample)
    expect(await p1).toEqual(sample)
    expect(await p2).toEqual(sample)

    // Within TTL, synchronous and async reads hit cache without calling fetcher again.
    clock += FILE_PREVIEW_CACHE_TTL_MS - 1_000
    expect(getCachedFilePreview(source, clock)).toEqual(sample)
    expect(await readFilePreview(source, { fetcher, now: () => clock })).toEqual(sample)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // After TTL expires, fetcher is called again.
    clock += 2_000
    expect(getCachedFilePreview(source, clock)).toBeNull()
    const updated: FileContent = { ...sample, text: 'export const a = 2', version: 'v2' }
    fetcher.mockResolvedValueOnce(updated)
    expect(await readFilePreview(source, { fetcher, now: () => clock })).toEqual(updated)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed reads and separates project vs agent cache keys', async () => {
    const projectSource: FilePreviewSource = {
      kind: 'project',
      projectPath: '/Users/dev/app',
      path: 'plan.md',
    }
    const agentSource: FilePreviewSource = {
      kind: 'agent',
      sessionId: 'sess-1',
      path: '/Users/dev/.claude/plans/plan.md',
    }
    expect(previewSourceKey(projectSource)).not.toBe(previewSourceKey(agentSource))

    const fetcher = vi
      .fn<(source: FilePreviewSource) => Promise<FileContent>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        kind: 'text',
        path: 'plan.md',
        size: 5,
        text: 'hello',
        version: 'v1',
        editable: true,
      })

    await expect(readFilePreview(projectSource, { fetcher })).rejects.toThrow('offline')
    expect(getCachedFilePreview(projectSource)).toBeNull()
    const recovered = await readFilePreview(projectSource, { fetcher })
    expect(recovered.kind).toBe('text')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used entries once cache count exceeds capacity', async () => {
    const fetcher = vi.fn(async (source: FilePreviewSource): Promise<FileContent> => ({
      kind: 'text',
      path: source.path,
      size: 4,
      text: 'code',
      version: 'v1',
      editable: true,
    }))
    for (let i = 0; i < 40; i++) {
      await readFilePreview(
        { kind: 'project', projectPath: '/Users/dev/app', path: `src/f-${i}.ts` },
        { fetcher, now: () => 10_000 },
      )
    }
    expect(
      getCachedFilePreview(
        { kind: 'project', projectPath: '/Users/dev/app', path: 'src/f-0.ts' },
        10_000,
      ),
    ).toBeNull()
    expect(
      getCachedFilePreview(
        { kind: 'project', projectPath: '/Users/dev/app', path: 'src/f-39.ts' },
        10_000,
      ),
    ).not.toBeNull()
  })

  it('resolves Shiki dual-theme token styles for both light and dark modes', () => {
    const token = {
      content: 'const',
      htmlStyle: {
        color: 'var(--syntax-keyword)',
        '--shiki-dark': 'var(--syntax-function)',
        'font-style': 'italic',
        '--shiki-dark-font-style': 'normal',
      },
    }
    expect(previewTokenStyle(token, false)).toEqual({
      color: 'var(--syntax-keyword)',
      fontStyle: 'italic',
    })
    expect(previewTokenStyle(token, true)).toEqual({
      color: 'var(--syntax-function)',
      fontStyle: 'normal',
    })
  })
})

describe('FileHoverPreview and FileHoverPreviewCard rendering', () => {
  async function loadPreviewComponents(options: { noHover?: boolean } = {}) {
    vi.resetModules()
    vi.doMock(
      '@hugeicons/core-free-icons',
      () =>
        new Proxy(
          {},
          {
            get: (_target, prop) =>
              prop === '__esModule' ? true : prop === 'then' ? undefined : prop,
            has: (_target, prop) => prop !== 'then',
          },
        ),
    )
    vi.doMock('@hugeicons/react', () => ({ HugeiconsIcon: () => null }))
    vi.doMock('react-i18next', () => ({
      initReactI18next: { type: '3rdParty', init: () => undefined },
      useTranslation: () => ({
        t: (key: string, params?: Record<string, string | number>) => {
          const table: Record<string, string> = {
            'hoverPreview.openInFiles': enFiles.hoverPreview.openInFiles,
            'hoverPreview.openFullFile': enFiles.hoverPreview.openFullFile,
            'hoverPreview.lineBadge': `L${params?.lines ?? ''}`,
            'hoverPreview.empty': enFiles.hoverPreview.empty,
            'hoverPreview.truncatedRange': `Showing lines ${params?.start}\u2013${params?.end} of ${params?.total}`,
            'hoverPreview.truncatedClipped': enFiles.hoverPreview.truncatedClipped,
            'hoverPreview.folderTitle': enFiles.hoverPreview.folderTitle,
            'hoverPreview.folderDescription': enFiles.hoverPreview.folderDescription,
            'hoverPreview.externalFileDescription': enFiles.hoverPreview.externalFileDescription,
            'hoverPreview.imageDimensions': `${params?.width} \u00d7 ${params?.height}`,
            'hoverPreview.mediaAudioTitle': enFiles.hoverPreview.mediaAudioTitle,
            'hoverPreview.mediaVideoTitle': enFiles.hoverPreview.mediaVideoTitle,
            'hoverPreview.mediaDocumentTitle': enFiles.hoverPreview.mediaDocumentTitle,
            'hoverPreview.mediaDescription': `${params?.size}. Click to preview in the Files pane.`,
            'hoverPreview.loadFailed': enFiles.hoverPreview.loadFailed,
            'hoverPreview.retry': enFiles.hoverPreview.retry,
            'preview.openFailed': enFiles.preview.openFailed,
            'preview.missing': enFiles.preview.missing,
            'preview.binaryTitle': enFiles.preview.binaryTitle,
            'preview.binaryDescription': `${params?.size}, not shown.`,
            'preview.tooLargeTitle': enFiles.preview.tooLargeTitle,
            'preview.tooLargeDescription': `${params?.size}; the preview shows files up to ${params?.limit}.`,
            'preview.mediaTooLargeTitle': enFiles.preview.mediaTooLargeTitle,
          }
          return table[key] ?? key
        },
      }),
    }))
    vi.doMock('@renderer/hooks/use-no-hover', () => ({
      useNoHover: () => options.noHover ?? false,
    }))
    vi.doMock('@renderer/hooks/use-dark', () => ({
      useDark: () => false,
    }))
    vi.doMock('@renderer/stores/themes', () => ({
      useThemesStore: (selector: (s: { shown: null }) => unknown) => selector({ shown: null }),
    }))
    vi.doMock('./file-type-icon', () => ({ FileTypeIcon: () => null }))
    vi.doMock('@renderer/components/ui/hover-card', () => ({
      HoverCard: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
        createElement('div', { 'data-mock-hover-card': open ? 'open' : 'closed' }, children),
      HoverCardTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
        createElement('span', { 'data-mock-hover-trigger': '' }, render, children),
      HoverCardContent: ({ className, children }: { className?: string; children?: ReactNode }) =>
        createElement('div', { 'data-mock-hover-content': '', className }, children),
    }))
    return import('./file-hover-preview')
  }

  afterEach(() => {
    vi.restoreAllMocks()
    clearFilePreviewCache()
  })

  it('renders scrollable text with highlighted target line range and truncation notice on desktop', async () => {
    const { FileHoverPreview } = await loadPreviewComponents({ noHover: false })
    const longFile = Array.from({ length: 500 }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n')
    const html = renderToStaticMarkup(
      createElement(FileHoverPreview, {
        open: true,
        source: { kind: 'project', projectPath: '/Users/dev/app', path: 'src/app.ts' },
        path: 'src/app.ts',
        range: { start: 420, end: 422 },
        onOpen: vi.fn(),
        initialContent: {
          kind: 'text',
          path: 'src/app.ts',
          size: longFile.length,
          text: longFile,
          version: 'v1',
          editable: true,
        },
        trigger: createElement('button', { type: 'button' }),
        children: 'app.ts:420\u2013422',
      }),
    )

    expect(html).toContain('data-mock-hover-card="open"')
    expect(html).toContain('data-file-hover-preview=""')
    expect(html).toContain('data-preview-code=""')
    expect(html).toContain('L420\u2013422')
    expect(html).toContain('data-preview-line="420" data-highlighted=""')
    expect(html).toContain('data-preview-line="421" data-highlighted=""')
    expect(html).toContain('data-preview-line="422" data-highlighted=""')
    expect(html).toContain('data-preview-truncated=""')
    expect(html).toContain('Showing lines 101\u2013500 of 500')
    expect(html).toContain('Open in Files')
    expect(html).toContain('Open full file')

    // Suppressing the preview (e.g. while ContextMenu is open) closes HoverCard and skips body render.
    const suppressedHtml = renderToStaticMarkup(
      createElement(FileHoverPreview, {
        open: true,
        suppressed: true,
        source: { kind: 'project', projectPath: '/Users/dev/app', path: 'src/app.ts' },
        path: 'src/app.ts',
        initialContent: {
          kind: 'text',
          path: 'src/app.ts',
          size: 10,
          text: 'const a = 1',
          version: 'v1',
          editable: true,
        },
        trigger: createElement('button', { type: 'button' }),
        children: 'app.ts',
      }),
    )
    expect(suppressedHtml).toContain('data-mock-hover-card="closed"')
    expect(suppressedHtml).not.toContain('data-file-hover-preview')
  })

  it('does not render HoverCard at all on touch/no-hover devices', async () => {
    const { FileHoverPreview } = await loadPreviewComponents({ noHover: true })
    const html = renderToStaticMarkup(
      createElement(FileHoverPreview, {
        open: true,
        source: { kind: 'project', projectPath: '/Users/dev/app', path: 'src/app.ts' },
        path: 'src/app.ts',
        range: { start: 5, end: 5 },
        onOpen: vi.fn(),
        trigger: createElement('button', { type: 'button', 'data-touch-trigger': '' }),
        children: 'app.ts',
      }),
    )

    expect(html).toContain('data-touch-trigger=""')
    expect(html).toContain('app.ts')
    expect(html).not.toContain('data-mock-hover-card')
    expect(html).not.toContain('data-file-hover-preview')
  })

  it('renders clean previews for binary, too-large, image, folder, missing, and error states', async () => {
    const { FileHoverPreviewCard } = await loadPreviewComponents({ noHover: false })

    const binaryHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'bin/app.wasm',
        initialContent: { kind: 'binary', path: 'bin/app.wasm', size: 4000 },
      }),
    )
    expect(binaryHtml).toContain('Binary file')
    expect(binaryHtml).toContain('4 KB, not shown.')

    const largeHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'logs/huge.log',
        initialContent: {
          kind: 'too-large',
          path: 'logs/huge.log',
          size: 5_000_000,
          limit: 1_000_000,
        },
      }),
    )
    expect(largeHtml).toContain('Too large to preview')
    expect(largeHtml).toContain('1 MB')

    const imageHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'assets/logo.png',
        initialContent: {
          kind: 'media',
          path: 'assets/logo.png',
          grant: {
            url: 'kettu-media://token/logo.png',
            kind: 'image',
            mimeType: 'image/png',
            size: 12_288,
            width: 320,
            height: 240,
          },
        },
      }),
    )
    expect(imageHtml).toContain('data-preview-image=""')
    expect(imageHtml).toContain('kettu-media://token/logo.png')
    expect(imageHtml).toContain('320 \u00d7 240')

    const folderHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'src/features',
        kind: 'folder',
      }),
    )
    expect(folderHtml).toContain('Folder')

    const missingErr = Object.assign(new Error('not found'), { code: 'not_found' })
    const missingHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: { kind: 'project', projectPath: '/Users/dev/app', path: 'gone.ts' },
        path: 'gone.ts',
        initialError: missingErr,
      }),
    )
    expect(missingHtml).toContain('This file is no longer on disk.')
    expect(missingHtml).not.toContain('data-preview-retry')

    const offlineHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: { kind: 'project', projectPath: '/Users/dev/app', path: 'remote.ts' },
        path: 'remote.ts',
        initialError: new Error('Host disconnected'),
      }),
    )
    expect(offlineHtml).toContain('Couldn&#x27;t load preview')
    expect(offlineHtml).toContain('Host disconnected')
    expect(offlineHtml).toContain('data-preview-retry=""')

    const emptyHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'empty.txt',
        initialContent: {
          kind: 'text',
          path: 'empty.txt',
          size: 0,
          text: '',
          version: 'v0',
          editable: true,
        },
      }),
    )
    expect(emptyHtml).toContain('data-preview-empty=""')
    expect(emptyHtml).toContain('Empty file.')

    const docHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'docs/report.pdf',
        initialContent: {
          kind: 'media',
          path: 'docs/report.pdf',
          grant: {
            url: 'kettu-media://token/report.pdf',
            kind: 'document',
            mimeType: 'application/pdf',
            size: 64_000,
          },
        },
      }),
    )
    expect(docHtml).toContain('Document')
    expect(docHtml).toContain('64 KB')

    const thumbHtml = renderToStaticMarkup(
      createElement(FileHoverPreviewCard, {
        source: null,
        path: 'screenshot.png',
        kind: 'image',
        thumb: 'data:image/png;base64,AAAA',
        size: 8192,
      }),
    )
    expect(thumbHtml).toContain('data-preview-image=""')
    expect(thumbHtml).toContain('data:image/png;base64,AAAA')
  })

  it('wires sent user message file chips into FileHoverPreview on desktop and skips HoverCard on touch', async () => {
    async function renderUserFileChip(noHover: boolean) {
      vi.resetModules()
      const storage = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      })
      const never = new Promise(() => {})
      vi.stubGlobal('window', {
        matchMedia: () => ({
          matches: noHover,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }),
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
          settings: {
            get: vi.fn(() => never),
            update: vi.fn(() => never),
            onChanged: () => () => {},
          },
          marketplace: { setKeys: vi.fn(() => never), setAgentEnv: vi.fn(() => never) },
          remote: { status: vi.fn(() => never), onChanged: () => () => {} },
          sharing: { status: vi.fn(() => never), onChanged: () => () => {} },
        },
      })
      vi.doMock('react-i18next', () => ({
        initReactI18next: { type: '3rdParty', init: () => undefined },
        useTranslation: () => ({ t: (key: string) => key }),
      }))
      vi.doMock(
        '@hugeicons/core-free-icons',
        () =>
          new Proxy(
            {},
            {
              get: (_target, prop) =>
                prop === '__esModule' ? true : prop === 'then' ? undefined : prop,
              has: (_target, prop) => prop !== 'then',
            },
          ),
      )
      vi.doMock('@hugeicons/react', () => ({ HugeiconsIcon: () => null }))
      vi.doMock('@renderer/hooks/use-no-hover', () => ({
        useNoHover: () => noHover,
      }))
      vi.doMock('@renderer/components/ui/hover-card', () => ({
        HoverCard: ({ children }: { children?: ReactNode }) =>
          createElement('span', { 'data-sent-hover-card': '' }, children),
        HoverCardTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
          createElement(Fragment, null, render, children),
        HoverCardContent: () => null,
      }))
      vi.doMock('@renderer/stores/files', () => ({
        ensureFiles: vi.fn(),
        openFile: vi.fn(),
        useFilesStore: (selector: (s: { byProject: Record<string, unknown> }) => unknown) =>
          selector({
            byProject: {
              '/Users/dev/app': {
                paths: ['src/auth.ts'],
                known: new Set(['src/auth.ts']),
              },
            },
          }),
      }))
      const { ProjectPathContext } = await import('./file-refs')
      const { UserContentView } = await import('../session/entries/user-content')
      return renderToStaticMarkup(
        createElement(
          ProjectPathContext,
          { value: '/Users/dev/app' },
          createElement(UserContentView, {
            content: [{ type: 'text', text: 'Please check @src/auth.ts:10-20' }],
          }),
        ),
      )
    }

    const desktopHtml = await renderUserFileChip(false)
    expect(desktopHtml).toContain('data-sent-hover-card=""')
    expect(desktopHtml).toContain('data-chip="file"')

    const touchHtml = await renderUserFileChip(true)
    expect(touchHtml).not.toContain('data-sent-hover-card')
    expect(touchHtml).toContain('data-chip="file"')
    vi.unstubAllGlobals()
  })

  it('provides matching English and Simplified Chinese hover preview locale entries', () => {
    expect(Object.keys(zhFiles.hoverPreview).sort()).toEqual(
      Object.keys(enFiles.hoverPreview).sort(),
    )
    expect(enFiles.hoverPreview.openInFiles).toBe('Open in Files')
    expect(zhFiles.hoverPreview.openInFiles).toBe('在文件面板打开')
  })
})
