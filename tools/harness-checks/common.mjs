// What every harness check shares: its log, the programs it runs, npm's listings, and a client
// for the newline-delimited JSON-RPC that Codex's app-server, DeepSeek Harness and ACP agents speak.

import { execFile, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How much of a check's log its result keeps, from the end. */
export const LOG_BYTES = 4096

/** A check's log, of which the result keeps the end; the check's folder shows as `<check>`. */
export class Log {
  text = ''

  constructor(dir = null) {
    // macOS gives the temporary folder under /var, which is /private/var once resolved.
    this.dirs = dir ? [`/private${dir}`, dir] : []
  }

  add(line) {
    let text = String(line).trimEnd()
    for (const dir of this.dirs) text = text.replaceAll(dir, '<check>')
    this.text += `${text}\n`
  }

  /** The last `bytes` of the log in UTF-8, starting at a line where one starts in reach. */
  tail(bytes = LOG_BYTES) {
    const all = Buffer.from(this.text, 'utf8')
    if (all.length <= bytes) return this.text
    let cut = all
      .subarray(all.length - bytes)
      .toString('utf8')
      .replace(/^�+/, '')
    const line = cut.indexOf('\n')
    if (line >= 0 && line < cut.length - 1) cut = cut.slice(line + 1)
    return cut
  }
}

/** A step of a check that did not hold, with what was seen. */
export class CheckFailure extends Error {
  name = 'CheckFailure'
}

export function expect(condition, message) {
  if (!condition) throw new CheckFailure(message)
}

/**
 * The environment a harness runs in: a home of its own and nothing of the runner's but `PATH`, so
 * no credential or setting of the machine reaches it.
 */
export async function harnessEnv(home, extra = {}) {
  await mkdir(home, { recursive: true })
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    ...extra,
  }
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
      if (process.env[name]) env[name] = process.env[name]
    }
  }
  return env
}

/** Runs a program to its end; its output goes to the log, and a non-zero exit throws. */
export async function runProgram(file, args, { cwd, env, log, timeoutMs = 5 * 60_000 }) {
  log.add(`$ ${[path.basename(file), ...args].join(' ')}`)
  try {
    const { stdout, stderr } = await run(file, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    if (stderr.trim()) log.add(stderr.trim())
    return stdout
  } catch (error) {
    if (error.stdout?.trim()) log.add(error.stdout.trim())
    if (error.stderr?.trim()) log.add(error.stderr.trim())
    const how = error.killed
      ? `was stopped after ${timeoutMs / 1000} s`
      : `failed: ${error.message}`
    throw new CheckFailure(`${path.basename(file)} ${how}`)
  }
}

/** What `npm view` prints as JSON, or null when the package or version does not exist. */
export async function npmView(spec, fields) {
  try {
    const { stdout } = await run('npm', ['view', spec, ...fields, '--json'], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    })
    return stdout.trim() ? JSON.parse(stdout) : null
  } catch (error) {
    if (/E404|No match found/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) return null
    throw error
  }
}

/**
 * The versions of an npm package in a range, by npm's own matching as the app's updates do, each
 * with the time npm says it was published.
 */
export async function npmVersions(name, range) {
  const [matching, times] = await Promise.all([
    npmView(`${name}@${range}`, ['version']),
    npmView(name, ['time']),
  ])
  const versions = matching === null ? [] : Array.isArray(matching) ? matching : [matching]
  return versions.map((version) => ({ version, publishedAt: times?.[version] ?? null }))
}

/**
 * A JSON-RPC peer over a program's stdin and stdout, one message per line. Requests the program
 * sends are answered as unknown, and what it writes to stderr goes to the log.
 */
export function startRpc(file, args, { cwd, env, log }) {
  log.add(`$ ${[path.basename(file), ...args].join(' ')}`)
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map()
  const notifications = []
  let exit = null
  let buffer = ''
  let stderr = ''
  let nextId = 1
  const settle = (message) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new CheckFailure(message))
    }
    pending.clear()
  }
  child.on('error', (error) => {
    exit = `could not start: ${error.message}`
    settle(`${path.basename(file)} ${exit}`)
  })
  child.on('exit', (code, signal) => {
    exit = signal ? `was stopped by ${signal}` : `exited with code ${code}`
    settle(`${path.basename(file)} ${exit} before it answered`)
  })
  child.stdin.on('error', () => {})
  child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text))
  child.stdout.setEncoding('utf8').on('data', (text) => {
    buffer += text
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        log.add(`(not JSON) ${line.slice(0, 300)}`)
        continue
      }
      if (message.method !== undefined && message.id !== undefined) {
        const answer = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Not handled' },
        }
        child.stdin.write(`${JSON.stringify(answer)}\n`)
      } else if (message.method !== undefined) {
        notifications.push(message)
      } else if (pending.has(message.id)) {
        const { resolve, timer } = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(timer)
        resolve(message)
      }
    }
  })
  return {
    notifications,
    /** The answer to a request: its `result`, or `{ error }` when it answered with an error. */
    request(method, params, timeoutMs = 120_000) {
      if (exit) return Promise.reject(new CheckFailure(`${path.basename(file)} ${exit}`))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new CheckFailure(`${method} had no answer within ${timeoutMs / 1000} s`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (message) =>
            resolve(message.error ? { error: message.error } : { result: message.result }),
          reject,
          timer,
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    /** Ends the program, its stderr going to the log. */
    async close() {
      if (!exit) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.stdin.end()
        child.kill()
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        await exited
        clearTimeout(timer)
      }
      if (stderr.trim()) log.add(stderr.trim())
    },
  }
}

/** The answer's `result`, or a failure naming the error it gave. */
export function resultOf(method, answer) {
  if (answer.error) {
    throw new CheckFailure(
      `${method} failed: ${answer.error.message ?? JSON.stringify(answer.error)}`,
    )
  }
  return answer.result
}

/** A short JSON form of a value for the log. */
export function brief(value, length = 300) {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > length ? `${text.slice(0, length)}...` : text
}
