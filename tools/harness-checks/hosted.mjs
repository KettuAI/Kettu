// What the checks of a harness's preferred interface share: the versions they look at, and a
// context in which Kettu's own connection for that interface runs, as the agent host runs it.

import { spawn } from 'node:child_process'
import path from 'node:path'
import major from 'semver/functions/major.js'
import satisfies from 'semver/functions/satisfies.js'
import minVersion from 'semver/ranges/min-version.js'
import { brief, CheckFailure, expect } from './common.mjs'

const OPTIONS = { includePrerelease: true }

/**
 * The versions a preferred interface is checked on: the catalog's range, which it takes by
 * default, and the next major version, which only the manifest can let through.
 */
export function candidateRange(def) {
  const oldest = minVersion(def.preferred.checked)
  if (!oldest) throw new Error(`${def.id} has no oldest checked version`)
  return `>=${oldest.version} <${major(oldest) + 2}.0.0`
}

/** Whether a version is past the range the catalog takes the preferred interface on. */
export function beyondCatalog(def, version) {
  return !satisfies(version, def.preferred.checked, OPTIONS)
}

/** The context a hosted driver's connection gets in the agent host, logging what it reports. */
export function hostedContext(def, ctx, { spec, env, ...extra }) {
  const children = []
  const hooks = {
    traffic: () => {},
    account: (account) => ctx.log.add(`account: ${brief(account)}`),
    authState: (state) => ctx.log.add(`sign-in: ${state}`),
    modelProviders: () => {},
    signInShown: () => {},
    accountRefused: () => {},
    ignored: () => {},
    log: (level, message) => ctx.log.add(`${level}: ${message}`),
  }
  const start = (options) => {
    ctx.log.add(`$ ${[path.basename(options.command), ...options.args].join(' ')}`)
    const child = spawn(options.command, options.args, {
      cwd: options.cwd ?? env.HOME,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text))
    child.on('error', () => {})
    children.push({ child, stderr: () => stderr })
    return child
  }
  return {
    context: {
      def,
      hooks,
      spec: { args: [], env: {}, shell: false, display: [], ...spec },
      env,
      spawn: start,
      ...extra,
    },
    /** Stops what is still running and logs the end of what it wrote to stderr. */
    async stop() {
      for (const { child, stderr } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve))
          child.stdin?.end()
          const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
          await exited
          clearTimeout(timer)
        }
        const text = stderr().trim()
        if (text) ctx.log.add(text.split('\n').slice(-40).join('\n'))
      }
    },
  }
}

/**
 * Runs a request of Kettu's connection, failing the step with what went wrong: there even a
 * TypeError is the harness answering what the connection cannot read, not a slip of these tools.
 */
export async function step(ctx, name, run, timeoutMs = 120_000) {
  ctx.step = name
  let timer
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new CheckFailure(`${name} had no answer within ${timeoutMs / 1000} s`)),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    if (error instanceof CheckFailure) throw error
    const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new CheckFailure(`${name} failed: ${what}`)
  } finally {
    clearTimeout(timer)
  }
}

/** The session's options of a category, failing when it has none to pick from. */
export function choicesOf(config, category) {
  const option = config.find((entry) => entry.category === category)
  const values = option?.choices?.map((choice) => choice.value) ?? []
  expect(values.length > 0, `The session offers no ${category}: ${brief(config)}`)
  return values
}
