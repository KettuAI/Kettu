// @ts-check
// Prints the color literals in the renderer's stylesheets, HTML and SVG files, which ESLint does
// not read. Exits 1 when it finds any. No dependencies.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { colorLiteralMessage, findColorLiterals, TOKEN_FILE } from './color-literals.mjs'
import { parseTokens } from './contrast.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCANNED = /\.(?:css|html|svg)$/i
// The drawings tools/brand/build.mjs writes keep the brand's own colors: the app icon, its fox,
// and the glyphs, whose colors only set their masks.
const BRAND_FILES = [
  'src/renderer/src/assets/kettu-icon.svg',
  'src/renderer/src/assets/kettu-fox.svg',
  'src/renderer/src/assets/kettu-glyph-on-dark.svg',
  'src/renderer/src/assets/kettu-glyph-on-light.svg',
]

/**
 * @param {string} text
 * @param {number} index
 * @returns {{ line: number, column: number }} 1-based
 */
export function locate(text, index) {
  const before = text.slice(0, index)
  const line = before.split('\n').length
  return { line, column: index - (before.lastIndexOf('\n') + 1) + 1 }
}

// A browser reads <meta name="theme-color"> as a plain color, so it cannot name a token. One may
// repeat the page background, --bg-app, of the scheme its media query names; no other color may.
const THEME_COLOR_META = /<meta\b(?=[^>]*\bname\s*=\s*["']theme-color["'])[^>]*>/gi
const META_MEDIA = /\bmedia\s*=\s*(["'])(.*?)\1/i
const META_CONTENT = /\bcontent\s*=\s*(["'])(.*?)\1/i
const SCHEME = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/i

/** @param {string} text */
const blank = (text) => text.replace(/[^\n]/g, ' ')

/**
 * @param {string} css the token file's text
 * @returns {{ light: string, dark: string }} the page background in each scheme
 */
export function pageBackgrounds(css) {
  const { light, dark } = parseTokens(css)
  const get = (/** @type {Map<string, string>} */ block, /** @type {string} */ name) => {
    const value = block.get(name)
    if (value === undefined) throw new Error(`${TOKEN_FILE} has no ${name}`)
    return value
  }
  return { light: get(light, '--bg-app'), dark: get(dark, '--bg-app') }
}

/**
 * Checks the `theme-color` meta tags of a page against the token file.
 *
 * @param {string} path
 * @param {string} text
 * @param {{ light: string, dark: string }} backgrounds
 * @returns {{ text: string, problems: string[] }} the text with the content of each tag checked
 *   blanked, so the color scan does not report it again, and what was wrong with the tags
 */
function checkThemeColors(path, text, backgrounds) {
  const scanned = text.replace(/<!--[\s\S]*?-->/g, blank)
  /** @type {string[]} */
  const problems = []
  let out = text
  for (const tag of scanned.matchAll(THEME_COLOR_META)) {
    const content = META_CONTENT.exec(tag[0])
    if (!content) continue
    const media = META_MEDIA.exec(tag[0])
    const scheme = media ? SCHEME.exec(media[2])?.[1]?.toLowerCase() : 'light'
    const start = tag.index + content.index + content[0].lastIndexOf(content[2])
    const expected = scheme === 'dark' || scheme === 'light' ? backgrounds[scheme] : undefined
    if (expected === undefined || content[2].trim().toLowerCase() !== expected.toLowerCase()) {
      const { line, column } = locate(text, start)
      problems.push(
        expected === undefined
          ? `${path}:${line}:${column} theme-color needs a media of prefers-color-scheme light or dark`
          : `${path}:${line}:${column} theme-color '${content[2]}' must be the ${scheme} --bg-app, '${expected}', of ${TOKEN_FILE}`,
      )
    }
    out = out.slice(0, start) + blank(content[2]) + out.slice(start + content[2].length)
  }
  return { text: out, problems }
}

/**
 * @param {string} path forward-slash path from the repository root
 * @param {string} text
 * @param {{ light: string, dark: string }} backgrounds
 * @returns {string[]} one `path:line:col message` per literal; none for the token file or the
 *   brand's drawings
 */
export function checkFile(path, text, backgrounds) {
  if (path === TOKEN_FILE || BRAND_FILES.includes(path)) return []
  const markup = !path.toLowerCase().endsWith('.css')
  const meta = markup ? checkThemeColors(path, text, backgrounds) : { text, problems: [] }
  const literals = findColorLiterals(meta.text, { css: true, markup }).map(({ index, match }) => {
    const { line, column } = locate(text, index)
    return `${path}:${line}:${column} ${colorLiteralMessage(match)}`
  })
  return [...meta.problems, ...literals]
}

/** @param {string} root @returns {string[]} forward-slash paths of the files to scan */
export function listFiles(root) {
  const dir = join(root, 'src', 'renderer')
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => SCANNED.test(file) && !file.split(sep).includes('node_modules'))
    .map((file) => relative(root, join(dir, file)).split(sep).join('/'))
    .sort()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = listFiles(ROOT)
  const backgrounds = pageBackgrounds(readFileSync(join(ROOT, TOKEN_FILE), 'utf8'))
  const problems = files.flatMap((path) =>
    checkFile(path, readFileSync(join(ROOT, path), 'utf8'), backgrounds),
  )
  for (const problem of problems) console.log(problem)
  if (problems.length > 0) process.exitCode = 1
}
