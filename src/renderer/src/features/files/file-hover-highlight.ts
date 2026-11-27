// Lazy Shiki syntax highlighting for the thread file hover preview.
// Dynamically imports Kettu's shared Shiki highlighter and code themes so the initial bundle stays small.

import type { CSSProperties } from 'react'
import type { Theme } from '@shared/themes'
import { languageFromFilePath } from './file-hover-model'

export interface PreviewToken {
  content: string
  color?: string
  htmlStyle?: Record<string, string>
}

interface HighlightModules {
  createCodePlugin: typeof import('@renderer/features/session/markdown/code-plugin').createCodePlugin
  codeThemes: typeof import('@renderer/features/session/markdown/code-themes').codeThemes
  codeThemeInput: typeof import('@renderer/features/session/markdown/code-themes').codeThemeInput
}

let loadedModules: HighlightModules | null = null
let loadingModules: Promise<HighlightModules> | null = null

function loadModules(): Promise<HighlightModules> {
  if (loadedModules) return Promise.resolve(loadedModules)
  if (!loadingModules) {
    loadingModules = Promise.all([
      import('@renderer/features/session/markdown/code-plugin'),
      import('@renderer/features/session/markdown/code-themes'),
    ]).then(([codePlugin, themes]) => {
      loadedModules = {
        createCodePlugin: codePlugin.createCodePlugin,
        codeThemes: themes.codeThemes,
        codeThemeInput: themes.codeThemeInput,
      }
      return loadedModules
    })
  }
  return loadingModules
}

function runHighlight(
  modules: HighlightModules,
  code: string,
  path: string,
  theme: Theme | null,
  callback: (tokens: PreviewToken[][]) => void,
): PreviewToken[][] | null {
  const language = languageFromFilePath(path)
  if (language === 'text') return null
  const pair = modules.codeThemes(theme)
  const themes: [
    ReturnType<typeof modules.codeThemeInput>,
    ReturnType<typeof modules.codeThemeInput>,
  ] = [modules.codeThemeInput(pair.light), modules.codeThemeInput(pair.dark)]
  const plugin = modules.createCodePlugin({ themes })
  const sync = plugin.highlight(
    {
      code,
      language: language as Parameters<typeof plugin.highlight>[0]['language'],
      themes,
      isIncomplete: false,
    },
    (result) => callback(result.tokens as PreviewToken[][]),
  )
  return sync ? (sync.tokens as PreviewToken[][]) : null
}

/**
 * Highlights `code` for `path` using Kettu's shared Shiki highlighter.
 * Returns tokenized lines synchronously when modules and cache are warm; otherwise invokes
 * `onTokens` asynchronously unless the returned cancel function is called first.
 */
export function highlightPreviewLines({
  code,
  path,
  theme,
  onTokens,
}: {
  code: string
  path: string
  theme: Theme | null
  onTokens: (tokens: PreviewToken[][]) => void
}): { sync: PreviewToken[][] | null; cancel: () => void } {
  if (!code || languageFromFilePath(path) === 'text') {
    return { sync: null, cancel: () => {} }
  }
  let cancelled = false
  const emit = (tokens: PreviewToken[][]) => {
    if (!cancelled) onTokens(tokens)
  }
  if (loadedModules) {
    const sync = runHighlight(loadedModules, code, path, theme, emit)
    return {
      sync,
      cancel: () => {
        cancelled = true
      },
    }
  }
  void loadModules()
    .then((modules) => {
      if (cancelled) return
      const sync = runHighlight(modules, code, path, theme, emit)
      if (sync) emit(sync)
    })
    .catch(() => {
      // Plain text remains visible if syntax highlighting cannot load.
    })
  return {
    sync: null,
    cancel: () => {
      cancelled = true
    },
  }
}

/** Resolves inline style properties for a dual-theme Shiki token in light or dark mode. */
export function previewTokenStyle(token: PreviewToken, dark: boolean): CSSProperties | undefined {
  const html = token.htmlStyle
  if (html) {
    const color = dark ? (html['--shiki-dark'] ?? html.color) : html.color
    const fontStyle = dark
      ? (html['--shiki-dark-font-style'] ?? html['font-style'])
      : html['font-style']
    const fontWeight = dark
      ? (html['--shiki-dark-font-weight'] ?? html['font-weight'])
      : html['font-weight']
    if (!color && !fontStyle && !fontWeight) return undefined
    return {
      ...(color ? { color } : {}),
      ...(fontStyle ? { fontStyle } : {}),
      ...(fontWeight ? { fontWeight } : {}),
    }
  }
  return token.color ? { color: token.color } : undefined
}
