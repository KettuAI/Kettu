// @ts-check
// Writes the Swift source the helper takes from the renderer at build time: every agent mark in
// the dark theme's colors, so the island draws the window's marks, the icon's fox, and the dark
// theme's values of the tokens it draws with. Marks are SVG, except those with filters or masks,
// which CoreSVG does not draw, and the fox, whose filters take CoreSVG about 140 ms: Chromium draws
// those to PNG through rasterize.mjs.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const MARKS_DIR = 'src/renderer/src/components/agents/marks'
const TOKENS = 'src/renderer/src/styles/tokens.css'
// The icon's shaded fox without its tile, which the island shows while nothing needs a mark.
const BRAND_FOX = 'src/renderer/src/assets/kettu-fox.svg'
// Marks drawn in `currentColor` take the island's primary text color.
const TEXT_COLOR = '#f2f2f7'

/** The `--name: value` pairs of the first block whose selector line is `selector`. */
function block(css, selector) {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`${TOKENS} has no ${selector} block`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) {
      const values = {}
      for (const m of css.slice(start, i).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
        values[m[1]] = m[2].trim()
      return values
    }
  }
  throw new Error(`${TOKENS}: the ${selector} block does not end`)
}

/** The dark theme's colors: the light block's, with the dark block's on top. */
function darkTokens(root) {
  const css = readFileSync(join(root, TOKENS), 'utf8')
  const light = block(css, ":root,\n[data-theme='light']") ?? {}
  return { ...light, ...block(css, "[data-theme='dark']") }
}

/** Loads the mark modules through TypeScript's transpiler, with packages from the repository. */
async function loadMarks(root) {
  const requireFromRoot = createRequire(join(root, 'package.json'))
  const ts = requireFromRoot('typescript')
  const dir = join(root, MARKS_DIR)
  // Packages are imported ahead, since some ship only as ES modules and the marks load synchronously.
  const packages = new Map()
  for (const name of readdirSync(dir)) {
    if (!/\.tsx?$/.test(name)) continue
    for (const m of readFileSync(join(dir, name), 'utf8').matchAll(
      /^import (?!type )[^'"]*['"]([^'"./][^'"]*)['"]/gm,
    )) {
      if (!packages.has(m[1])) packages.set(m[1], await import(m[1]))
    }
  }
  const cache = new Map()
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports
    const source = readFileSync(file, 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: file,
    })
    const module = { exports: {} }
    cache.set(file, module)
    const require = (id) => {
      if (!id.startsWith('.')) return packages.get(id) ?? requireFromRoot(id)
      const base = join(dirname(file), id)
      const found = ['.tsx', '.ts'].map((ext) => base + ext).find((path) => existsSync(path))
      if (!found) throw new Error(`${file}: cannot find ${id}`)
      return load(found)
    }
    new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
    return module.exports
  }
  return { marks: load(join(dir, 'index.ts')).AGENT_MARKS, requireFromRoot }
}

/**
 * Path data with every token apart. The SVG grammar lets an arc's two flags run into the numbers
 * around them, as in `0 012.285`, which CoreSVG reads as one number, dropping the rest of the path.
 */
function separateArcFlags(d) {
  const command = /[\s,]*([A-Za-z])/y
  const number = /[\s,]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y
  const flag = /[\s,]*([01])/y
  const out = []
  let at = 0
  let arc = false
  let index = 0
  while (at < d.length) {
    command.lastIndex = at
    const c = command.exec(d)
    if (c) {
      out.push(c[1])
      arc = c[1] === 'A' || c[1] === 'a'
      index = 0
      at = command.lastIndex
      continue
    }
    const token = arc && (index % 7 === 3 || index % 7 === 4) ? flag : number
    token.lastIndex = at
    const m = token.exec(d)
    if (!m) {
      if (/^[\s,]*$/.test(d.slice(at))) break
      throw new Error(`Cannot read path data at ${at}: ${d.slice(at, at + 24)}`)
    }
    out.push(m[1])
    index += 1
    at = token.lastIndex
  }
  return out.join(' ')
}

/** Every harness's mark as a standalone SVG document, keyed by harness id. */
export async function renderMarks(root) {
  const tokens = darkTokens(root)
  const { marks, requireFromRoot } = await loadMarks(root)
  const { createElement } = requireFromRoot('react')
  const { renderToStaticMarkup } = requireFromRoot('react-dom/server')
  const resolve = (svg) =>
    svg
      .replace(/var\((--[a-z0-9-]+)\)/g, (whole, name) => {
        const value = tokens[name]
        if (!value) throw new Error(`No dark value for ${name}`)
        return value
      })
      .replaceAll('currentColor', TEXT_COLOR)
      .replace(/ d="([^"]*)"/g, (whole, d) =>
        /[Aa]/.test(d) ? ` d="${separateArcFlags(d)}"` : whole,
      )
  const out = {}
  for (const [harness, { viewBox, Body }] of Object.entries(marks)) {
    const markup = renderToStaticMarkup(
      createElement(
        'svg',
        { xmlns: 'http://www.w3.org/2000/svg', viewBox, width: 64, height: 64 },
        createElement(Body, { mono: false }),
      ),
    )
    out[harness] = resolve(markup)
  }
  return { marks: out, tokens }
}

// The added agents' dot colors, and the signals' colors.
const AGENT_DOTS = ['teal', 'violet', 'amber', 'rose', 'green', 'slate']
const TOKENS_USED = [
  'attention-dot',
  'attention',
  'danger',
  'success',
  'warning',
  'usage-red',
  'usage-green',
  'send',
  'shell-accent',
  'merged',
]

function hex(tokens, name) {
  const value = tokens[`--${name}`]
  if (!/^#[0-9a-f]{6}$/i.test(value ?? ''))
    throw new Error(`--${name} is not a plain color: ${value}`)
  return value
}

const NEEDS_CHROMIUM = /<(filter|mask)\b/
const FOX_KEY = '@fox'

/** The SVG documents given as base64 PNGs, drawn by Chromium in the repository's Electron. */
function rasterize(root, svgs) {
  const electron = createRequire(join(root, 'package.json'))('electron')
  const work = mkdtempSync(join(tmpdir(), 'kettu-island-images-'))
  try {
    const input = join(work, 'input.json')
    const output = join(work, 'output.json')
    writeFileSync(input, JSON.stringify(svgs))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const script = join(dirname(fileURLToPath(import.meta.url)), 'rasterize.mjs')
    const result = spawnSync(electron, [script, input, output], { encoding: 'utf8', env })
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr.trim()
      throw new Error(`Chromium could not draw the island's images: ${detail}`)
    }
    return JSON.parse(readFileSync(output, 'utf8'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * The Swift source: `markSVG` and `markPNG` (base64) by harness, `agentDotHex` by color name,
 * `tokenHex` by token and `brandFoxPNG` (base64).
 */
export async function generatedSwift(root) {
  const { marks, tokens } = await renderMarks(root)
  const vector = Object.entries(marks).filter(([, svg]) => !NEEDS_CHROMIUM.test(svg))
  const drawn = rasterize(root, {
    ...Object.fromEntries(Object.entries(marks).filter(([, svg]) => NEEDS_CHROMIUM.test(svg))),
    [FOX_KEY]: readFileSync(join(root, BRAND_FOX), 'utf8'),
  })
  const { [FOX_KEY]: fox, ...pngs } = drawn
  const lit = (text) => JSON.stringify(text)
  const table = (name, entries) => [
    `let ${name}: [String: String] = [`,
    ...entries.map(([key, value]) => `  ${lit(key)}: ${lit(value)},`),
    ']',
    '',
  ]
  return [
    '// Generated by native/island/generate.mjs from the renderer. Do not edit.',
    '',
    ...table('markSVG', vector),
    ...table('markPNG', Object.entries(pngs)),
    ...table(
      'agentDotHex',
      AGENT_DOTS.map((name) => [name, hex(tokens, `agent-${name}`)]),
    ),
    ...table(
      'tokenHex',
      TOKENS_USED.map((name) => [name, hex(tokens, name)]),
    ),
    `let brandFoxPNG = ${lit(fox)}`,
    '',
  ].join('\n')
}
