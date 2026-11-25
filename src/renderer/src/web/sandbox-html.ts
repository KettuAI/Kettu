// HTML assembler for hosted and relay web clients: runs `servedHtml` first to preserve exact
// `data-kettu-src` offsets against the host's source HTML, then inlines or rewrites same-version
// stylesheets, scripts, ES modules, and media before injecting the VFS bootstrap shim.

import sandboxShimScript from 'virtual:kettu-sandbox-shim'
import { ARTIFACT_ENTRY, artifactFileType } from '@shared/artifact-files'
import { servedHtml, type CanvasPage } from '@shared/artifact-page'
import { SANDBOX_VIEWER_PREFIX } from '@shared/artifact-policy'
import { eachStartTag, type SourceAttribute } from '@shared/artifact-source'
import { VIEWER_PREFIX, viewerPage, type ArtifactTypeInfo } from '@shared/artifact-types'
import type { Locale } from '@shared/locale'
import type { SandboxShimConfig } from './sandbox-shim'

/** Media files larger than this stay out of inline HTML and are served via VFS blob URLs. */
export const MAX_INLINE_ASSET_BYTES = 4 * 1024 * 1024

const SKIP_SCHEME = /^(?:https?:|\/\/|data:|blob:|mailto:|tel:|javascript:|about:|#)/i
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)|"([^"]+)"|'([^']+)')([^;]*);/gi
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]+))\s*\)/gi
const STATIC_IMPORT_RE = /\b((?:import|export)\s+(?:[\s\S]*?\s+from\s+)?)(["'])([^"']+)\2/g
const DYNAMIC_IMPORT_RE = /\b(import\s*\(\s*)(["'])([^"']+)\2(\s*\))/g

/** Returns the directory prefix of a path (empty at root, trailing '/' for subdirectories). */
export function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash < 0 ? '' : filePath.slice(0, slash + 1)
}

/**
 * Resolves a relative or root-relative reference against `baseDir` and verifies membership in
 * `files`. Returns null for path traversal, external schemes, or unknown files.
 */
export function resolveArtifactPath(
  baseDir: string,
  rawRef: string,
  files: ReadonlySet<string>,
): string | null {
  const trimmed = rawRef.trim()
  if (!trimmed || SKIP_SCHEME.test(trimmed)) return null
  const withoutFragment = trimmed.split('#')[0]!.split('?')[0]!
  if (!withoutFragment) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    decoded = withoutFragment
  }
  const combined = decoded.startsWith('/') ? decoded.slice(1) : `${baseDir}${decoded}`
  const parts: string[] = []
  for (const segment of combined.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  const resolved = parts.join('/')
  return files.has(resolved) ? resolved : null
}

/** Encodes bytes as a base64 `data:<mimeType>;base64,...` URL. */
export function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** Sequentially replaces every regex match using an async replacer. */
async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const regex = new RegExp(pattern.source, pattern.flags)
  let out = ''
  let last = 0
  for (let m = regex.exec(text); m; m = regex.exec(text)) {
    out += text.slice(last, m.index)
    out += await replacer(m)
    last = m.index + m[0].length
    if (m[0].length === 0) regex.lastIndex++
  }
  return last === 0 ? text : out + text.slice(last)
}

/** Recursively inlines local CSS `@import` rules and rewrites local `url(...)` assets to data URLs. */
export async function rewriteCss(
  css: string,
  cssPath: string,
  files: ReadonlySet<string>,
  readText: (path: string) => Promise<string | null>,
  readDataUrl: (path: string) => Promise<string | null>,
  visited = new Set<string>(),
): Promise<string> {
  const baseDir = dirOf(cssPath)
  const inlinedImports = await replaceAsync(css, CSS_IMPORT_RE, async (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
    const media = (match[6] ?? '').trim()
    const target = resolveArtifactPath(baseDir, raw, files)
    if (!target || visited.has(target)) return match[0]
    const imported = await readText(target)
    if (imported === null) return match[0]
    const nextVisited = new Set(visited)
    nextVisited.add(target)
    const rewritten = await rewriteCss(imported, target, files, readText, readDataUrl, nextVisited)
    return media ? `@media ${media} {\n${rewritten}\n}` : rewritten
  })
  return replaceAsync(inlinedImports, CSS_URL_RE, async (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    const target = resolveArtifactPath(baseDir, raw, files)
    if (!target) return match[0]
    const url = await readDataUrl(target)
    return url ? `url("${url}")` : match[0]
  })
}

/** Recursively rewrites relative ES module import, export, and dynamic import() specifiers to data URLs. */
async function rewriteModuleJs(
  code: string,
  jsPath: string,
  files: ReadonlySet<string>,
  readText: (path: string) => Promise<string | null>,
  compiled: Map<string, string>,
  stack = new Set<string>(),
): Promise<string> {
  const baseDir = dirOf(jsPath)
  const resolveDep = async (specifier: string): Promise<string | null> => {
    const target = resolveArtifactPath(baseDir, specifier, files)
    if (!target || stack.has(target)) return null
    const cached = compiled.get(target)
    if (cached) return cached
    const depText = await readText(target)
    if (depText === null) return null
    const nextStack = new Set(stack)
    nextStack.add(target)
    const depRewritten = await rewriteModuleJs(
      depText,
      target,
      files,
      readText,
      compiled,
      nextStack,
    )
    const encoded = toDataUrl(
      new TextEncoder().encode(depRewritten),
      'text/javascript;charset=utf-8',
    )
    compiled.set(target, encoded)
    return encoded
  }

  const afterStatic = await replaceAsync(code, STATIC_IMPORT_RE, async (match) => {
    const [, prefix, quote, specifier] = match
    const url = await resolveDep(specifier!)
    return url ? `${prefix}${quote}${url}${quote}` : match[0]
  })

  return replaceAsync(afterStatic, DYNAMIC_IMPORT_RE, async (match) => {
    const [, prefix, quote, specifier, suffix] = match
    const url = await resolveDep(specifier!)
    return url ? `${prefix}${quote}${url}${quote}${suffix}` : match[0]
  })
}

async function rewriteSrcset(
  srcset: string,
  baseDir: string,
  files: ReadonlySet<string>,
  readDataUrl: (path: string) => Promise<string | null>,
): Promise<string | null> {
  let changed = false
  const parts = srcset.split(',')
  const out: string[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const space = trimmed.search(/\s/)
    const rawUrl = space < 0 ? trimmed : trimmed.slice(0, space)
    const descriptor = space < 0 ? '' : trimmed.slice(space)
    const target = resolveArtifactPath(baseDir, rawUrl, files)
    if (target) {
      const dataUrl = await readDataUrl(target)
      if (dataUrl) {
        changed = true
        out.push(`${dataUrl}${descriptor}`)
        continue
      }
    }
    out.push(trimmed)
  }
  return changed ? out.join(', ') : null
}

function findRawClose(
  html: string,
  tagName: string,
  from: number,
): { contentEnd: number; tagEnd: number } | null {
  const closeRe = new RegExp(`</${tagName}(?=[\\s/>])[^>]*>`, 'gi')
  closeRe.lastIndex = from
  const match = closeRe.exec(html)
  if (!match) return null
  return { contentEnd: match.index, tagEnd: match.index + match[0].length }
}

function attrOf(attrs: readonly SourceAttribute[], name: string): SourceAttribute | undefined {
  return attrs.find((a) => a.name === name)
}

function isStylesheetRel(rel: string | null): boolean {
  if (!rel) return false
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.includes('stylesheet') && !tokens.includes('alternate')
}

function isClassicScriptType(type: string | null): boolean {
  if (type === null || type.trim() === '') return true
  const lower = type.trim().toLowerCase().split(';')[0]!.trim()
  return (
    lower === 'text/javascript' ||
    lower === 'application/javascript' ||
    lower === 'application/ecmascript' ||
    lower === 'text/ecmascript'
  )
}

function serializeAttr(attr: SourceAttribute, valueOverride?: string): string {
  const val = valueOverride ?? attr.value
  if (val === null) return attr.name
  return `${attr.name}="${escapeAttrValue(val)}"`
}

/** Inserts the VFS bootstrap shim right after any doctype and before page-runtime. */
export function withSandboxShim(html: string, config: SandboxShimConfig): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  const script =
    `<script>(()=>{${sandboxShimScript};__kettuSandboxShim.start(${json});` +
    'document.currentScript?.remove()})()</script>'
  const at = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0
  return html.slice(0, at) + script + html.slice(at)
}

export interface AssembleHtmlOptions {
  html: string
  path: string
  page: CanvasPage | null
  files: ReadonlySet<string>
  readText: (path: string) => Promise<string | null>
  readDataUrl: (path: string) => Promise<string | null>
}

interface EditOp {
  start: number
  end: number
  replacement: string
}

/**
 * Assembles a web page or canvas frame for the sandbox shell: runs `servedHtml` first to keep
 * exact source offsets, inlines local styles/scripts/media, and prepends the VFS bootstrap shim.
 */
export async function assembleHtml({
  html,
  path,
  page,
  files,
  readText,
  readDataUrl,
}: AssembleHtmlOptions): Promise<string> {
  // Inject page-runtime and data-kettu-src first so byte offsets match the host's original HTML.
  const served = servedHtml(html, page, { path, transport: 'port' })
  const baseDir = dirOf(path)
  const edits: EditOp[] = []
  const deferredScripts: string[] = []
  const compiledModules = new Map<string, string>()

  const tags: Array<{
    start: number
    name: string
    nameEnd: number
    end: number
    attributes: SourceAttribute[]
  }> = []
  eachStartTag(served, (tag) => {
    tags.push(tag)
  })

  // Track </head> so local `<script defer>` tags in <head> can be moved right before </body>.
  const headClose = served.search(/<\/head\s*>/i)

  for (const tag of tags) {
    // Inline local `<link rel="stylesheet">` tags and local icon links.
    if (tag.name === 'link') {
      const rel = attrOf(tag.attributes, 'rel')
      const href = attrOf(tag.attributes, 'href')
      if (isStylesheetRel(rel?.value ?? null) && href?.value) {
        const target = resolveArtifactPath(baseDir, href.value, files)
        if (target) {
          const cssText = await readText(target)
          if (cssText !== null) {
            const rewritten = await rewriteCss(
              cssText,
              target,
              files,
              readText,
              readDataUrl,
              new Set([target]),
            )
            const kept = tag.attributes
              .filter(
                (a) =>
                  a.name !== 'rel' &&
                  a.name !== 'href' &&
                  a.name !== 'as' &&
                  a.name !== 'crossorigin',
              )
              .map((a) => serializeAttr(a))
              .join(' ')
            const attrs = kept ? ` ${kept}` : ''
            edits.push({
              start: tag.start,
              end: tag.end,
              replacement: `<style${attrs}>${escapeInlineStyle(rewritten)}</style>`,
            })
            continue
          }
        }
      }
      // Inline local icon links (e.g. `<link rel="icon" href="...">`) as data URLs.
      if (href?.value) {
        const target = resolveArtifactPath(baseDir, href.value, files)
        if (target) {
          const dataUrl = await readDataUrl(target)
          if (dataUrl) {
            edits.push({
              start: href.start,
              end: href.end,
              replacement: serializeAttr(href, dataUrl),
            })
          }
        }
      }
      continue
    }

    if (tag.name === 'style') {
      const close = findRawClose(served, 'style', tag.end)
      if (close) {
        const rawCss = served.slice(tag.end, close.contentEnd)
        if (rawCss.includes('url(') || /@import/i.test(rawCss)) {
          const rewritten = await rewriteCss(rawCss, path, files, readText, readDataUrl)
          if (rewritten !== rawCss) {
            edits.push({
              start: tag.end,
              end: close.contentEnd,
              replacement: escapeInlineStyle(rewritten),
            })
          }
        }
      }
      continue
    }

    if (tag.name === 'script') {
      const close = findRawClose(served, 'script', tag.end)
      if (!close) continue
      const srcAttr = attrOf(tag.attributes, 'src')
      const typeAttr = attrOf(tag.attributes, 'type')
      const typeVal = typeAttr?.value ?? null
      const isModule = typeVal?.trim().toLowerCase() === 'module'

      if (srcAttr?.value) {
        const target = resolveArtifactPath(baseDir, srcAttr.value, files)
        if (target && (isModule || isClassicScriptType(typeVal))) {
          const jsText = await readText(target)
          if (jsText !== null) {
            const finalJs = isModule
              ? await rewriteModuleJs(
                  jsText,
                  target,
                  files,
                  readText,
                  compiledModules,
                  new Set([target]),
                )
              : jsText
            const hasDefer = !isModule && tag.attributes.some((a) => a.name === 'defer')
            const kept = tag.attributes
              .filter(
                (a) =>
                  a.name !== 'src' &&
                  a.name !== 'defer' &&
                  a.name !== 'async' &&
                  a.name !== 'integrity' &&
                  a.name !== 'crossorigin',
              )
              .map((a) => serializeAttr(a))
              .join(' ')
            const attrs = kept ? ` ${kept}` : ''
            const inlineTag = `<script${attrs}>${escapeInlineScript(finalJs)}</script>`
            if (hasDefer && headClose >= 0 && tag.start < headClose) {
              edits.push({ start: tag.start, end: close.tagEnd, replacement: '' })
              deferredScripts.push(inlineTag)
            } else {
              edits.push({ start: tag.start, end: close.tagEnd, replacement: inlineTag })
            }
            continue
          }
        }
      } else if (isModule) {
        const rawCode = served.slice(tag.end, close.contentEnd)
        if (/\b(?:import|export)\b/.test(rawCode)) {
          const rewritten = await rewriteModuleJs(rawCode, path, files, readText, compiledModules)
          if (rewritten !== rawCode) {
            edits.push({
              start: tag.end,
              end: close.contentEnd,
              replacement: escapeInlineScript(rewritten),
            })
          }
        }
      }
      continue
    }

    // Rewrite static media attributes and inline style="...url(...)...".
    for (const attr of tag.attributes) {
      if (attr.value === null) continue
      if (
        (attr.name === 'src' &&
          (tag.name === 'img' ||
            tag.name === 'source' ||
            tag.name === 'video' ||
            tag.name === 'audio' ||
            tag.name === 'input')) ||
        (attr.name === 'poster' && tag.name === 'video') ||
        ((attr.name === 'href' || attr.name === 'xlink:href') && tag.name === 'image')
      ) {
        const target = resolveArtifactPath(baseDir, attr.value, files)
        if (target) {
          const dataUrl = await readDataUrl(target)
          if (dataUrl) {
            edits.push({
              start: attr.start,
              end: attr.end,
              replacement: serializeAttr(attr, dataUrl),
            })
          }
        }
      } else if (attr.name === 'srcset' && (tag.name === 'img' || tag.name === 'source')) {
        const rewritten = await rewriteSrcset(attr.value, baseDir, files, readDataUrl)
        if (rewritten !== null) {
          edits.push({
            start: attr.start,
            end: attr.end,
            replacement: serializeAttr(attr, rewritten),
          })
        }
      } else if (attr.name === 'style' && attr.value.includes('url(')) {
        const rewritten = await rewriteCss(attr.value, path, files, readText, readDataUrl)
        if (rewritten !== attr.value) {
          edits.push({
            start: attr.start,
            end: attr.end,
            replacement: serializeAttr(attr, rewritten),
          })
        }
      }
    }
  }

  // Apply non-overlapping replacements in source order.
  edits.sort((a, b) => a.start - b.start)
  let assembled = ''
  let cursor = 0
  for (const edit of edits) {
    if (edit.start < cursor) continue
    assembled += served.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  assembled += served.slice(cursor)

  // Re-insert deferred local head scripts right before </body> in original declaration order.
  if (deferredScripts.length > 0) {
    const block = deferredScripts.join('\n')
    const bodyClose = assembled.search(/<\/body\s*>/i)
    assembled =
      bodyClose >= 0
        ? assembled.slice(0, bodyClose) + block + assembled.slice(bodyClose)
        : assembled + block
  }

  return withSandboxShim(assembled, {
    baseDir,
    files: [...files],
  })
}

export interface AssembleViewerOptions {
  type: ArtifactTypeInfo
  version: number
  locale: Locale
  files: ReadonlySet<string>
  entryPath: string
  entryText: string | null
}

/**
 * Assembles the sandbox HTML for a built-in typed viewer (document or slides): static viewer
 * bundles load from same-origin `/_kettu/viewer/` while the content file is preloaded into the VFS.
 */
export function assembleViewerHtml({
  type,
  version,
  locale,
  files,
  entryPath,
  entryText,
}: AssembleViewerOptions): string | null {
  const rawPage = viewerPage(type, version, locale, '')
  if (!rawPage) return null
  // Rewrite relative `_kettu/viewer/` paths to absolute `/_kettu/viewer/` regardless of shell path.
  const page = rawPage.replaceAll(VIEWER_PREFIX, SANDBOX_VIEWER_PREFIX)
  const served = servedHtml(page, null, { path: ARTIFACT_ENTRY, transport: 'port' })
  return withSandboxShim(served, {
    baseDir: '',
    files: [...files],
    ...(entryText !== null
      ? { preloaded: { [entryPath]: { type: artifactFileType(entryPath), text: entryText } } }
      : {}),
  })
}
