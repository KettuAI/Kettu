// The Codex app-server protocol as Kettu's mapping reads it: the JSON Schema bundle that
// `codex app-server generate-json-schema --experimental` writes, cut to the methods the mapping
// calls or handles and the fields and values its source names, and committed beside the mapping.
// A newer Codex's bundle is compared with it: what it adds passes, and a method, field, tagged
// variant or value of the cut that it lacks fails.
//
//   node tools/harness-checks/codex-schema.mjs write [<codex version>]
//     Writes the cut from that Codex, by default the oldest the mapping accepts.
//   node tools/harness-checks/codex-schema.mjs compare <bundle folder>
//     Lists what a generated bundle lacks, and exits 1 when it lacks anything.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessEnv, runProgram } from './common.mjs'
import { loadKettu, oldestOf, ROOT } from './kettu.mjs'

export const CUT_FILE = path.join(ROOT, 'src/agent-host/codex/app-server.schema.json')
export const BUNDLE_FILE = 'codex_app_server_protocol.schemas.json'

/** The protocol's messages, each a union of variants tagged by `method`. */
const UNIONS = ['ClientRequest', 'ClientNotification', 'ServerRequest', 'ServerNotification']
/** The unions whose requests have answers, which a `result` field links to by name. */
const ANSWERED = new Set(['ClientRequest', 'ServerRequest'])
/** The mapping's source, whose names choose what the cut keeps. */
const SOURCES = ['src/agent-host/codex', 'src/agent-host/marketplace/codex-plugins.ts']
const TAG_ORDER = ['method', 'type', 'mode', 'kind']

/** A bundle's node at a `#/definitions/...` reference. */
function resolve(bundle, ref) {
  if (!ref.startsWith('#/definitions/')) return undefined
  let node = bundle.definitions
  for (const key of ref.slice('#/definitions/'.length).split('/')) node = node?.[key]
  return node
}

/**
 * Gives every request variant a `result` field that refers to its answer, `<Name>Response` for
 * params of `<Name>Params`, since the bundle names answers only by that convention.
 */
export function linkAnswers(bundle) {
  const linked = structuredClone(bundle)
  for (const union of ANSWERED) {
    for (const variant of linked.definitions[union]?.oneOf ?? []) {
      const ref = findRef(variant.properties?.params)
      const answer = ref?.replace(/Params$/, 'Response')
      if (ref && answer !== ref && resolve(linked, answer)) {
        variant.properties.result = { $ref: answer }
      }
    }
  }
  return linked
}

function findRef(node) {
  if (!node || typeof node !== 'object') return undefined
  if (typeof node.$ref === 'string') return node.$ref
  for (const member of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    const ref = findRef(member)
    if (ref) return ref
  }
  return undefined
}

/** A variant's tag, such as `type=agentMessage`: a field that takes one value only. */
function tagOf(bundle, variant) {
  const node = variant.$ref ? resolve(bundle, variant.$ref) : variant
  const properties = node?.properties
  if (!properties) return null
  const names = Object.keys(properties).sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
  for (const name of names) {
    const values = properties[name]?.enum
    if (Array.isArray(values) && values.length === 1) return { name, value: values[0] }
  }
  return null
}

function rank(name) {
  const at = TAG_ORDER.indexOf(name)
  return at < 0 ? TAG_ORDER.length : at
}

/** The identifiers and strings in the mapping's source, its comments and tests left out. */
export async function mappingNames() {
  const require = createRequire(path.join(ROOT, 'package.json'))
  const ts = require('typescript')
  const words = new Set()
  const strings = new Set()
  for (const file of await sourceFiles()) {
    const text = await readFile(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
    const visit = (node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) words.add(node.text)
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
        words.add(node.text)
        strings.add(node.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { words, strings }
}

async function sourceFiles() {
  const files = []
  for (const entry of SOURCES) {
    const full = path.join(ROOT, entry)
    if (full.endsWith('.ts')) {
      files.push(full)
      continue
    }
    for (const name of await readdir(full)) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path.join(full, name))
    }
  }
  return files.sort()
}

/**
 * The bundle cut to the variants of the protocol's unions whose methods the mapping names, the
 * definitions they reach, and in each only the fields the mapping names; a tagged variant stays
 * when the mapping names its tag's value, an enum keeps the values it names.
 */
export function cutBundle(bundle, { words, strings }, about) {
  const linked = linkAnswers(bundle)
  const definitions = {}
  const done = new Set()
  const place = (ref, node) => {
    const keys = ref.slice('#/definitions/'.length).split('/')
    let target = definitions
    for (const key of keys.slice(0, -1)) target = target[key] ??= {}
    target[keys[keys.length - 1]] = node
  }
  const visit = (node) => {
    if (typeof node !== 'object' || node === null) return node
    if (Array.isArray(node)) return node.map(visit)
    if (typeof node.$ref === 'string') {
      if (!done.has(node.$ref)) {
        done.add(node.$ref)
        const target = resolve(linked, node.$ref)
        if (target === undefined) throw new Error(`The bundle has no ${node.$ref}`)
        place(node.$ref, visit(target))
      }
      return { $ref: node.$ref }
    }
    const out = {}
    if (node.type !== undefined) out.type = node.type
    if (Array.isArray(node.enum)) {
      const values = node.enum.length === 1 ? node.enum : node.enum.filter((v) => strings.has(v))
      if (values.length > 0) out.enum = values
    }
    if (node.properties) {
      const kept = Object.keys(node.properties).filter((name) => words.has(name))
      out.properties = Object.fromEntries(kept.map((name) => [name, visit(node.properties[name])]))
      const required = (node.required ?? []).filter((name) => kept.includes(name))
      if (required.length > 0) out.required = required
    }
    if (node.items !== undefined) out.items = visit(node.items)
    if (typeof node.additionalProperties === 'object') {
      out.additionalProperties = visit(node.additionalProperties)
    }
    for (const key of ['oneOf', 'anyOf']) {
      if (!Array.isArray(node[key])) continue
      const kept = node[key].filter((variant) => {
        const tag = tagOf(linked, variant)
        return !tag || strings.has(tag.value)
      })
      out[key] = kept.map(visit)
    }
    if (Array.isArray(node.allOf)) out.allOf = node.allOf.map(visit)
    return out
  }
  for (const union of UNIONS) {
    const node = linked.definitions[union]
    if (!node) throw new Error(`The bundle has no ${union}`)
    place(`#/definitions/${union}`, visit(node))
  }
  return {
    $schema: bundle.$schema,
    title: 'CodexAppServerProtocolAsKettuReadsIt',
    description: about,
    definitions,
  }
}

/**
 * The leaves of a node: references followed, `allOf` merged and union members marked, with the
 * references passed through, which stop a walk around a recursive type.
 */
function leaves(bundle, nodes) {
  const out = []
  const refs = []
  const walk = (node, member, seen) => {
    if (typeof node !== 'object' || node === null) return
    if (typeof node.$ref === 'string') {
      if (seen.has(node.$ref)) return
      refs.push(node.$ref)
      walk(resolve(bundle, node.$ref), member, new Set([...seen, node.$ref]))
      return
    }
    for (const part of node.allOf ?? []) walk(part, member, seen)
    for (const key of ['oneOf', 'anyOf']) for (const part of node[key] ?? []) walk(part, true, seen)
    if (node.properties || node.items || node.enum || node.additionalProperties || node.type) {
      out.push({ node, tag: member ? tagOf(bundle, node) : null })
    }
  }
  for (const node of nodes) walk(node, false, new Set())
  return { leaves: out, refs: refs.sort().join(',') }
}

function shape(bundle, nodes) {
  const found = leaves(bundle, nodes)
  const result = {
    refs: found.refs,
    tagged: new Map(),
    fields: new Map(),
    values: new Set(),
    items: [],
    extra: [],
  }
  for (const { node, tag } of found.leaves) {
    if (tag) {
      const key = `${tag.name}=${tag.value}`
      result.tagged.set(key, [...(result.tagged.get(key) ?? []), node])
      continue
    }
    for (const [name, value] of Object.entries(node.properties ?? {})) {
      result.fields.set(name, [...(result.fields.get(name) ?? []), value])
    }
    for (const value of node.enum ?? []) result.values.add(value)
    if (node.items !== undefined) result.items.push(...[node.items].flat())
    if (typeof node.additionalProperties === 'object') result.extra.push(node.additionalProperties)
  }
  return result
}

/** What of the cut a generated bundle lacks, as paths such as `ServerNotification<method=x>.params.y`. */
export function compareBundle(cut, generated) {
  const bundle = linkAnswers(generated)
  const missing = []
  const visited = new Set()
  const walk = (ours, theirs, at) => {
    const a = shape(cut, ours)
    const b = shape(bundle, theirs)
    if (a.refs) {
      const key = `${a.refs}|${b.refs}`
      if (visited.has(key)) return
      visited.add(key)
    }
    for (const [key, nodes] of a.tagged) {
      const match = b.tagged.get(key)
      if (match) walk(nodes, match, `${at}<${key}>`)
      else missing.push(`${at}<${key}>`)
    }
    for (const [name, nodes] of a.fields) {
      const match = b.fields.get(name)
      if (match) walk(nodes, match, `${at}.${name}`)
      else missing.push(`${at}.${name}`)
    }
    for (const value of a.values) if (!b.values.has(value)) missing.push(`${at}=${value}`)
    if (a.items.length > 0) {
      if (b.items.length > 0) walk(a.items, b.items, `${at}[]`)
      else missing.push(`${at}[]`)
    }
    if (a.extra.length > 0) {
      if (b.extra.length > 0) walk(a.extra, b.extra, `${at}{}`)
      else missing.push(`${at}{}`)
    }
  }
  for (const union of UNIONS) {
    const theirs = bundle.definitions[union]
    if (theirs) walk([cut.definitions[union]], [theirs], union)
    else missing.push(union)
  }
  return missing
}

export async function readBundle(dir) {
  return JSON.parse(await readFile(path.join(dir, BUNDLE_FILE), 'utf8'))
}

export async function readCut() {
  return JSON.parse(await readFile(CUT_FILE, 'utf8'))
}

/** The arguments with which Codex writes its schema bundle into `out`. */
export function generateArgs(out) {
  return ['app-server', 'generate-json-schema', '--experimental', '--out', out]
}

async function main(args) {
  const [command, value] = args
  if (command === 'compare' && value) {
    const missing = compareBundle(await readCut(), await readBundle(path.resolve(value)))
    for (const line of missing) console.log(line)
    console.log(
      missing.length > 0 ? `Lacks ${missing.length} of the cut.` : 'Lacks nothing of the cut.',
    )
    process.exitCode = missing.length > 0 ? 1 : 0
    return
  }
  if (command === 'write') {
    await writeCut(value)
    return
  }
  console.error('Usage: codex-schema.mjs write [<codex version>] | compare <bundle folder>')
  process.exitCode = 2
}

/** Writes the cut of a generated bundle, formatted as the repository formats JSON. */
export async function saveCut(dir, version) {
  const names = await mappingNames()
  const about =
    `Codex ${version}'s app-server protocol (generate-json-schema --experimental), cut to the ` +
    'methods, fields and values the mapping names; written by tools/harness-checks/codex-schema.mjs.'
  const cut = cutBundle(await readBundle(dir), names, about)
  const prettier = await import('prettier')
  const options = (await prettier.resolveConfig(CUT_FILE)) ?? {}
  const text = await prettier.format(JSON.stringify(cut), { ...options, filepath: CUT_FILE })
  await writeFile(CUT_FILE, text)
  return { bytes: Buffer.byteLength(text), missing: compareBundle(cut, await readBundle(dir)) }
}

/** Writes the committed cut from a Codex version, by default the oldest the mapping accepts. */
export async function writeCut(version) {
  const kettu = await loadKettu()
  const def = kettu.buildCatalog(null).find((entry) => entry.id === 'codex')
  const target = version ?? oldestOf(def)
  if (!target) throw new Error('The catalog names no Codex version to write the cut from')
  await withTempDir('kettu-codex-schema-', async (dir) => {
    const npm = await kettu.findCommand('npm', {
      platform: process.platform,
      env: process.env,
      isExecutable: (file) => kettu.isExecutableFile(file, process.platform),
    })
    if (!npm) throw new Error('npm is not on PATH')
    const install = await kettu.installAdapter({
      root: path.join(dir, 'installs'),
      agentId: 'codex',
      package: def.installs.npm,
      version: target,
      npm,
      nodeVersion: process.versions.node,
      platform: process.platform,
      env: process.env,
      timeoutMs: 15 * 60_000,
    })
    const env = await harnessEnv(path.join(dir, 'home'), {
      CODEX_HOME: path.join(dir, 'home', '.codex'),
    })
    await mkdir(env.CODEX_HOME, { recursive: true })
    const out = path.join(dir, 'schema')
    const log = { add: () => {} }
    await runProgram(process.execPath, [install.entry, ...generateArgs(out)], {
      cwd: dir,
      env,
      log,
    })
    const { bytes, missing } = await saveCut(out, target)
    if (missing.length > 0)
      throw new Error(`The cut does not match its own bundle: ${missing.join(', ')}`)
    console.log(`Wrote the cut of Codex ${target}'s protocol, ${bytes} bytes.`)
  })
}

async function withTempDir(prefix, work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2))
