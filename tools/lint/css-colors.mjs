// @ts-check
// Prints the color literals in the renderer's stylesheets, HTML and SVG files, which ESLint does
// not read. Exits 1 when it finds any. No dependencies.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { colorLiteralMessage, findColorLiterals, TOKEN_FILE } from './color-literals.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCANNED = /\.(?:css|html|svg)$/i
// The drawings tools/brand/build.mjs writes keep the brand's own colors: the app icon, and the
// glyphs, whose colors only set their masks.
const BRAND_FILES = [
  'src/renderer/src/assets/kettu-icon.svg',
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

/**
 * @param {string} path forward-slash path from the repository root
 * @param {string} text
 * @returns {string[]} one `path:line:col message` per literal; none for the token file or the
 *   brand's drawings
 */
export function checkFile(path, text) {
  if (path === TOKEN_FILE || BRAND_FILES.includes(path)) return []
  const markup = !path.toLowerCase().endsWith('.css')
  return findColorLiterals(text, { css: true, markup }).map(({ index, match }) => {
    const { line, column } = locate(text, index)
    return `${path}:${line}:${column} ${colorLiteralMessage(match)}`
  })
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
  const problems = files.flatMap((path) => checkFile(path, readFileSync(join(ROOT, path), 'utf8')))
  for (const problem of problems) console.log(problem)
  if (problems.length > 0) process.exitCode = 1
}
