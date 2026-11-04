// A Vite plugin for the type viewers' build: writes `parts.json`, which lists for each viewer the
// files its page always loads, and apart from them the files each code language adds, so a
// published copy carries only the languages its content uses instead of every one Shiki knows.

import { bundledLanguagesInfo } from 'shiki'
import type { Plugin, Rolldown } from 'vite'

export const PARTS_FILE = 'parts.json'

const LANGUAGE = /[\\/]@shikijs[\\/]langs[\\/]dist[\\/]([^\\/]+)\.mjs$/
// The viewers give Shiki themes of their own and its JavaScript engine, so they never load these.
const UNUSED =
  /[\\/](@shikijs[\\/]themes[\\/]dist[\\/][^\\/]+|shiki[\\/]dist[\\/]wasm|@shikijs[\\/]engine-oniguruma[\\/]dist[\\/]wasm-inlined)\.mjs$/
const CSS_URL = /url\(\s*['"]?\.\/([^'")?#]+)/g

export interface ViewerParts {
  /** Each name a fence may give a language, by the language's id. */
  aliases: Record<string, string>
  viewers: Record<string, { files: string[]; languages: Record<string, string[]> }>
}

export function viewerParts(): Plugin {
  return {
    name: 'kettu:viewer-parts',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunks = new Map<string, Rolldown.OutputChunk>()
      const styles = new Map<string, string>()
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') chunks.set(item.fileName, item)
        else if (item.fileName.endsWith('.css')) styles.set(item.fileName, String(item.source))
      }
      /** Whether every module of the chunk is one of `pattern`'s. */
      const only = (file: string, pattern: RegExp): boolean => {
        const ids = chunks.get(file)?.moduleIds ?? []
        return ids.length > 0 && ids.every((id) => pattern.test(id))
      }
      /** The languages a chunk of Shiki's grammars holds, several when Rolldown merged them. */
      const languagesIn = (file: string): string[] =>
        only(file, LANGUAGE) ? chunks.get(file)!.moduleIds.map((id) => LANGUAGE.exec(id)![1]!) : []
      /** A chunk, what it imports, and their styles and the files those name. */
      const closure = (file: string, into = new Set<string>()): Set<string> => {
        if (into.has(file)) return into
        into.add(file)
        const chunk = chunks.get(file)
        if (!chunk) return into
        for (const css of chunk.viteMetadata?.importedCss ?? []) {
          into.add(css)
          const dir = css.includes('/') ? css.slice(0, css.lastIndexOf('/') + 1) : ''
          for (const [, url] of (styles.get(css) ?? '').matchAll(CSS_URL)) into.add(`${dir}${url}`)
        }
        for (const asset of chunk.viteMetadata?.importedAssets ?? []) into.add(asset)
        for (const imported of chunk.imports) closure(imported, into)
        return into
      }
      const parts: ViewerParts = { aliases: {}, viewers: {} }
      for (const info of bundledLanguagesInfo) {
        for (const name of [info.id, ...(info.aliases ?? [])]) parts.aliases[name] = info.id
      }
      for (const entry of chunks.values()) {
        if (!entry.isEntry) continue
        const files = new Set<string>()
        const languages = new Map<string, string>()
        const pending = [entry.fileName]
        while (pending.length > 0) {
          for (const file of closure(pending.pop()!)) {
            if (files.has(file)) continue
            files.add(file)
            for (const later of chunks.get(file)?.dynamicImports ?? []) {
              if (only(later, UNUSED)) continue
              const held = languagesIn(later)
              for (const language of held) languages.set(language, later)
              if (held.length === 0) pending.push(later)
            }
          }
        }
        const byLanguage: Record<string, string[]> = {}
        for (const [language, file] of languages) {
          byLanguage[language] = [...closure(file)].filter((part) => !files.has(part))
        }
        parts.viewers[entry.name] = { files: [...files].sort(), languages: byLanguage }
      }
      this.emitFile({ type: 'asset', fileName: PARTS_FILE, source: JSON.stringify(parts) })
    },
  }
}
