// @ts-check
// Decides whether a Release run signs macOS with the Developer ID, from which signing secrets are
// set. The workflow passes only whether each
// secret is set, as HAS_<NAME>=true or false, never its value. Run it the same way:
//
//   HAS_CSC_LINK=true HAS_CSC_KEY_PASSWORD=false ... node tools/workflow/mac-signing.mjs
//
// It writes signed (true or false) and notarize (api-key, apple-id or empty) to $GITHUB_OUTPUT.
// No dependencies.

import { appendFileSync } from 'node:fs'

/** @typedef {'certificate' | 'api-key' | 'apple-id'} SetName */
/** @typedef {{ name: SetName, label: string, secrets: string[] }} SecretSet */
/** @typedef {{ signed: false }} Unsigned */
/** @typedef {{ signed: true, notarize: 'api-key' | 'apple-id', unused: SetName[] }} Signed */
/** @typedef {Unsigned | Signed | { failure: string }} Decision */

/** @type {Record<SetName, SecretSet>} */
export const SETS = {
  certificate: {
    name: 'certificate',
    label: 'the certificate',
    secrets: ['CSC_LINK', 'CSC_KEY_PASSWORD'],
  },
  'api-key': {
    name: 'api-key',
    label: 'the App Store Connect API key',
    secrets: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  },
  'apple-id': {
    name: 'apple-id',
    label: 'the Apple ID',
    secrets: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  },
}
export const SECRETS = Object.values(SETS).flatMap((set) => set.secrets)

/** @param {string[]} names */
function list(names) {
  return names.length < 3
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** @param {string[]} names */
function isAre(names) {
  return `${list(names)} ${names.length > 1 ? 'are' : 'is'}`
}

/** @param {SetName} name */
function label(name) {
  return `${SETS[name].label} (${list(SETS[name].secrets)})`
}

/**
 * Each set is either complete or absent. Without any, macOS stays ad-hoc signed; with the
 * certificate and a way to notarize, it is signed, preferring the API key over the Apple ID.
 *
 * @param {Iterable<string>} present the names of the secrets that are set
 * @returns {Decision}
 */
export function decide(present) {
  const have = new Set(present)
  for (const set of Object.values(SETS)) {
    const given = set.secrets.filter((name) => have.has(name))
    const missing = set.secrets.filter((name) => !have.has(name))
    if (given.length > 0 && missing.length > 0) {
      return {
        failure: `macOS signing is half configured: ${isAre(given)} set, but ${isAre(missing)} not. Set all of ${label(set.name)}, or none of it.`,
      }
    }
  }
  const certificate = have.has('CSC_LINK')
  const apiKey = have.has('APPLE_API_KEY')
  const appleId = have.has('APPLE_ID')
  if (!certificate && !apiKey && !appleId) return { signed: false }
  if (!certificate) {
    return {
      failure: `macOS signing is half configured: notarization credentials are set, but ${label('certificate')} is not.`,
    }
  }
  if (apiKey) return { signed: true, notarize: 'api-key', unused: appleId ? ['apple-id'] : [] }
  if (appleId) return { signed: true, notarize: 'apple-id', unused: [] }
  return {
    failure: `macOS signing is half configured: ${label('certificate')} is set, but nothing to notarize with. Set ${label('api-key')} or ${label('apple-id')}.`,
  }
}

/**
 * The line the run logs about the path it took.
 *
 * @param {Unsigned | Signed} decision
 */
export function summary(decision) {
  if (!decision.signed) {
    return 'macOS: no signing secrets are set, so the builds are ad-hoc signed and updates link to the release (Link mode).'
  }
  return [
    `macOS: signed with the Developer ID from ${label('certificate')} and notarized with ${label(decision.notarize)}, so updates install in place (Install mode).`,
    ...decision.unused.map((name) => {
      const text = label(name)
      return `${text[0].toUpperCase()}${text.slice(1)} is set too and is not used.`
    }),
  ].join(' ')
}

/**
 * Reads HAS_<NAME> for every secret. Anything but true or false is a mistake in the workflow,
 * which would otherwise read as a missing secret.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ present: string[], problems: string[] }}
 */
export function readPresence(env) {
  /** @type {string[]} */
  const present = []
  /** @type {string[]} */
  const problems = []
  for (const name of SECRETS) {
    const value = env[`HAS_${name}`]
    if (value === 'true') present.push(name)
    else if (value !== 'false') problems.push(`HAS_${name} must be true or false.`)
  }
  return { present, problems }
}

/** @param {'notice' | 'error'} level @param {string} message */
function annotate(level, message) {
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::${level}::${message}` : message)
}

if (import.meta.main) {
  const { present, problems } = readPresence(process.env)
  const decision = problems.length > 0 ? { failure: problems.join(' ') } : decide(present)
  if ('failure' in decision) {
    annotate('error', decision.failure)
    process.exitCode = 1
  } else {
    annotate('notice', summary(decision))
    const output = `signed=${decision.signed}\nnotarize=${decision.signed ? decision.notarize : ''}\n`
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
    else process.stdout.write(output)
  }
}
