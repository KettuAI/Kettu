// Signing, runner readiness and failure classification for physical iOS/iPadOS devices.

import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DeviceProblem } from '@shared/device-host'
import type { Env } from '../agent-host/find-command'

export type PhysicalIosRunnerProblem = 'runner-unsigned' | 'runner-untrusted' | 'ui-automation-off'

export type PhysicalIosRunnerState =
  | { status: 'unverified' }
  | { status: 'checking' }
  | { status: 'ready'; team: string }
  | {
      status: 'failed'
      problem: PhysicalIosRunnerProblem | null
      team: string
      at: number
    }

export type PhysicalIosRunnerProbeResult =
  { ok: true } | { ok: false; problem: PhysicalIosRunnerProblem | null; message: string }

export interface RunnerFailureDiagnostic {
  reason?: string | null
  code?: string | null
  message?: string | null
  stdout?: string | null
  stderr?: string | null
  hint?: string | null
  logTail?: string | null
}

const SECURITY_BIN = '/usr/bin/security'
const SECURITY_TIMEOUT_MS = 5_000
const SECURITY_MAX_BUFFER = 4 * 1024 * 1024
const MAX_LOG_TAIL_BYTES = 65_536
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/i
const CODE_SIGNING_IDENTITY_LINE =
  /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]*(?:Apple Development|iPhone Developer)[^"]*)"/
const PEM_CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

export interface SecurityRunner {
  (args: string[], env: Env): Promise<string | null>
}

function defaultRunSecurity(args: string[], env: Env): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      SECURITY_BIN,
      args,
      { env, timeout: SECURITY_TIMEOUT_MS, maxBuffer: SECURITY_MAX_BUFFER },
      (error, stdout) => resolve(error ? null : String(stdout ?? '')),
    ),
  )
}

/** Valid Apple Development / iPhone Developer code-signing SHA-1 fingerprints from `security`. */
export function parseCodeSigningIdentities(stdout: string): Set<string> {
  const fingerprints = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = CODE_SIGNING_IDENTITY_LINE.exec(line)
    if (match?.[1]) fingerprints.add(match[1].toUpperCase())
  }
  return fingerprints
}

/**
 * First unexpired Apple development team ID (`OU=<10 chars>`) from PEM certificates.
 * When `validFingerprints` is provided, only certificates backed by a valid signing identity match.
 */
export function extractDevelopmentTeamFromPem(
  pem: string,
  validFingerprints?: ReadonlySet<string>,
  now = Date.now(),
): string | null {
  for (const block of pem.match(PEM_CERT_BLOCK) ?? []) {
    try {
      const cert = new X509Certificate(block)
      const validFrom = Date.parse(cert.validFrom)
      const validTo = Date.parse(cert.validTo)
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) continue
      if (now < validFrom || now > validTo) continue
      if (validFingerprints) {
        const fingerprint = cert.fingerprint.replace(/:/g, '').toUpperCase()
        if (!validFingerprints.has(fingerprint)) continue
      }
      const team = /^OU=([A-Z0-9]{10})$/m.exec(cert.subject)?.[1]
      if (team) return team
    } catch {
      // Ignore certificates Node cannot parse.
    }
  }
  return null
}

/**
 * Resolves the Apple development team ID for signing the XCTest runner on a physical iOS device:
 * an explicit `AGENT_DEVICE_IOS_TEAM_ID` first, then a valid code-signing identity in the keychain.
 */
export async function findDevelopmentTeam(
  env: Env,
  deps?: { runSecurity?: SecurityRunner; now?: number },
): Promise<string | null> {
  const configured = env.AGENT_DEVICE_IOS_TEAM_ID?.trim()
  if (configured && TEAM_ID_PATTERN.test(configured)) return configured.toUpperCase()
  const runSecurity = deps?.runSecurity ?? defaultRunSecurity
  const now = deps?.now ?? Date.now()
  const [identitiesOut, appleDevPem] = await Promise.all([
    runSecurity(['find-identity', '-v', '-p', 'codesigning'], env),
    runSecurity(['find-certificate', '-a', '-c', 'Apple Development', '-p'], env),
  ])
  if (identitiesOut === null) return null
  const validFingerprints = parseCodeSigningIdentities(identitiesOut)
  if (validFingerprints.size === 0) return null
  if (appleDevPem) {
    const team = extractDevelopmentTeamFromPem(appleDevPem, validFingerprints, now)
    if (team) return team
  }
  if (/iPhone Developer/i.test(identitiesOut)) {
    const legacyPem = await runSecurity(
      ['find-certificate', '-a', '-c', 'iPhone Developer', '-p'],
      env,
    )
    if (legacyPem) {
      const team = extractDevelopmentTeamFromPem(legacyPem, validFingerprints, now)
      if (team) return team
    }
  }
  return null
}

const SIGNING_REASONS = new Set([
  'signing_no_development_team',
  'signing_provisioning_profile_missing',
  'bundle_identifier_already_registered',
  'signing_unspecified',
  'ios_runner_device_not_provisioned',
  'runner_product_repair_failed',
])

const BASE_PRECONDITION_REASONS = new Set([
  'device_developer_mode_disabled',
  'device_developer_disk_image_unavailable',
])

/**
 * Maps a physical iOS runner build, install or launch failure to the setup step it proves is
 * missing. Returns null when the failure does not prove one of the three runner steps.
 */
export function classifyPhysicalIosRunnerFailure(
  diagnostic: RunnerFailureDiagnostic,
): PhysicalIosRunnerProblem | null {
  const reason = diagnostic.reason?.trim().toLowerCase() ?? ''
  const code = diagnostic.code?.trim().toLowerCase() ?? ''
  if (BASE_PRECONDITION_REASONS.has(reason)) return null

  const text = [
    diagnostic.reason,
    diagnostic.code,
    diagnostic.message,
    diagnostic.hint,
    diagnostic.stdout,
    diagnostic.stderr,
    diagnostic.logTail,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .toLowerCase()

  if (!text) return null

  // Exclude earlier prerequisites so they are never misclassified as runner steps.
  if (
    text.includes('developer mode is disabled') ||
    text.includes('must be paired') ||
    text.includes('trust this computer') ||
    text.includes('trust this mac')
  ) {
    return null
  }

  // Check developer trust before signing: SpringBoard's untrusted launch error also mentions
  // "invalid code signature" alongside "profile has not been explicitly trusted by the user".
  if (
    text.includes('has not been explicitly trusted') ||
    text.includes('not been explicitly trusted') ||
    text.includes('not explicitly trusted') ||
    text.includes('untrusted developer') ||
    text.includes('untrusted enterprise developer') ||
    text.includes('vpn & device management') ||
    text.includes('profiles & device management') ||
    (text.includes('device management') && text.includes('trust')) ||
    (text.includes('verify app') &&
      (text.includes('developer') ||
        text.includes('trust') ||
        text.includes('device management') ||
        text.includes('settings'))) ||
    text.includes('trust the developer') ||
    text.includes('trust this developer') ||
    text.includes('user has not trusted') ||
    (text.includes('developer certificate') && text.includes('not trusted')) ||
    text.includes('0xe8008019')
  ) {
    return 'runner-untrusted'
  }

  // Check Enable UI Automation on the device. Ignore macOS DevToolsSecurity errors.
  if (reason !== 'devtools_security_developer_mode_disabled') {
    if (
      text.includes('enable ui automation') ||
      (text.includes('ui automation') &&
        /(disabled|not enabled|turned off|\boff\b|enable|turn on|not configured|not authorized|denied|failed|unavailable|required)/.test(
          text,
        )) ||
      (text.includes('uiautomation') &&
        /(disabled|not enabled|\boff\b|denied|failed|unavailable)/.test(text)) ||
      (text.includes('automation mode') &&
        /(disabled|not enabled|timed out|timeout|failed|unable to enable|could not enable|denied|requires)/.test(
          text,
        )) ||
      text.includes('failed to start automation') ||
      text.includes('could not start automation') ||
      text.includes('unable to start automation') ||
      ((text.includes('com.apple.dt.xctest.xctfuture') ||
        text.includes('com.apple.dt.xctest.xctestfuture')) &&
        (text.includes('1000') || text.includes('automation')))
    ) {
      return 'ui-automation-off'
    }
  }

  if (
    SIGNING_REASONS.has(reason) ||
    SIGNING_REASONS.has(code) ||
    text.includes('requires a development team') ||
    text.includes('no signing certificate') ||
    text.includes('no signing identities') ||
    text.includes('no profiles for') ||
    text.includes('failed registering bundle identifier') ||
    (text.includes('app identifier') && text.includes('not available')) ||
    (text.includes('provisioning profile') &&
      /(missing|doesn't include|does not include|has expired|not found|failed|couldn't find|ideprovisioningerrordomain|not valid|no valid)/.test(
        text,
      )) ||
    (text.includes('code signing') &&
      /(required|failed|error|identity|not configured)/.test(text)) ||
    text.includes('0xe8008012') ||
    text.includes('0xe8008015') ||
    text.includes('0xe8008016') ||
    text.includes('0xe8008018') ||
    text.includes('sign in to xcode') ||
    text.includes('add a developer account') ||
    text.includes('no accounts with app store connect access')
  ) {
    return 'runner-unsigned'
  }

  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Extracts structured error fields and runner log path from an `agent-device --json` failure. */
export function parseAgentDeviceFailureJson(
  stdout: string,
  stderr: string,
): RunnerFailureDiagnostic & { logPath?: string } {
  const raw = stdout.trim()
  if (raw.startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(raw))
      const error = asRecord(parsed?.error)
      if (error) {
        const details = asRecord(error.details)
        const nested = asRecord(details?.details)
        const xcodebuild = asRecord(details?.xcodebuild)
        const logPath =
          asString(details?.logPath) ??
          asString(details?.runnerLogPath) ??
          asString(nested?.logPath) ??
          undefined
        return {
          code: asString(error.code),
          message: asString(error.message),
          reason: asString(details?.reason) ?? asString(nested?.reason),
          hint: asString(details?.hint) ?? asString(nested?.hint),
          stdout:
            [asString(details?.stdout), asString(nested?.stdout)].filter(Boolean).join('\n') ||
            null,
          stderr:
            [
              asString(details?.stderr),
              asString(nested?.stderr),
              asString(xcodebuild?.stderr),
              stderr.trim() || null,
            ]
              .filter(Boolean)
              .join('\n') || null,
          ...(logPath ? { logPath } : {}),
        }
      }
    } catch {
      // Fall through to plain-text output.
    }
  }
  const logPath = extractDiagnosticLogPath(`${stdout}\n${stderr}`)
  return {
    stdout: stdout || null,
    stderr: stderr || null,
    ...(logPath ? { logPath } : {}),
  }
}

export function extractDiagnosticLogPath(text: string): string | undefined {
  const match = /(?:Diagnostics Log|Runner log|logPath)\s*[:=]\s*(\/\S+)/i.exec(text)
  return match?.[1]
}

/**
 * Reads the trailing bytes of an agent-device runner log, restricted to the OS temp directory or
 * Kettu's data folder so untrusted output cannot make the host read arbitrary files.
 */
export async function readRunnerLogTail(
  logPath: string,
  dataDir: string | null,
): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(logPath))
    const roots = [os.tmpdir(), ...(dataDir ? [dataDir] : [])]
    const allowed = await Promise.all(
      roots.map(async (root) => {
        try {
          return await realpath(path.resolve(root))
        } catch {
          return path.resolve(root)
        }
      }),
    )
    const inside = allowed.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    )
    if (!inside) return null
    const handle = await open(resolved, 'r')
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size === 0) return null
      const length = Math.min(stats.size, MAX_LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, stats.size - length)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Combines `devicectl`'s base prerequisites with signing and runner verification state for a
 * physical iOS/iPadOS device. Never marks developer trust or UI Automation done until the runner
 * has actually been verified on the device.
 */
export function physicalIosProblems(
  baseProblems: readonly DeviceProblem[],
  hasSigningTeam: boolean,
  runnerState: PhysicalIosRunnerState,
): DeviceProblem[] {
  const problems: DeviceProblem[] = [...baseProblems]
  const add = (problem: DeviceProblem): void => {
    if (!problems.includes(problem)) problems.push(problem)
  }

  if (!hasSigningTeam) {
    add('runner-unsigned')
    add('runner-untrusted')
    add('ui-automation-off')
    return problems
  }

  if (runnerState.status === 'ready') {
    if (baseProblems.length > 0) {
      add('runner-untrusted')
      add('ui-automation-off')
    }
    return problems
  }

  if (runnerState.status === 'failed') {
    if (runnerState.problem === 'runner-unsigned') {
      add('runner-unsigned')
      add('runner-untrusted')
      add('ui-automation-off')
      return problems
    }
    if (runnerState.problem === 'ui-automation-off') {
      add('ui-automation-off')
      return problems
    }
    add('runner-untrusted')
    add('ui-automation-off')
    return problems
  }

  // Unverified or currently checking: signing team is present, while trust and UI Automation
  // remain open until the runner probe succeeds.
  add('runner-untrusted')
  add('ui-automation-off')
  return problems
}
