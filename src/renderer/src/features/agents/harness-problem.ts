// Why a harness cannot run, said the same way wherever it is named: one short state, one sentence
// and the one action that fixes it; and which copy of its program runs.

import type { AgentStatus, HarnessReason } from '@shared/agent-host'
import { i18n } from '@renderer/lib/i18n'
import { awaitsPackage, hasProgram } from '@renderer/stores/agents'

/** What fixes it: installing the harness, a tool it needs, updating or choosing its program. */
export type ProblemFix = 'install' | 'node' | 'npm' | 'uv' | 'update' | 'choose'

export interface HarnessProblem {
  reason: HarnessReason
  /** The short state, as a list, a pill or a select says it: "Needs Node.js 22 or later". */
  label: string
  /** The sentence, which for a program that cannot run also says why. */
  text: string
  fix: ProblemFix | null
}

/** Where each tool is installed from, by the guide its makers keep. */
export const FIX_URLS = {
  node: 'https://nodejs.org/en/download',
  npm: 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm',
  uv: 'https://docs.astral.sh/uv/getting-started/installation/',
} as const

/** The reason an older host, which names none, says only by its state and its program. */
function olderReason(status: AgentStatus): HarnessReason {
  if (status.state !== 'not-installed')
    return { kind: 'needs-node', minimum: null, installed: null }
  const installed = status.cli?.installed
  const problem = installed?.problem
  if (problem?.kind === 'too-old') {
    return { kind: 'too-old', minimum: problem.minimum, installed: installed?.version ?? null }
  }
  if (problem) return { kind: 'cannot-run', why: status.detail ?? '' }
  return { kind: 'not-installed' }
}

/** Why the harness cannot run, or null when it can. */
export function harnessReason(status: AgentStatus): HarnessReason | null {
  switch (status.state) {
    case 'not-installed':
    case 'node-missing':
    case 'node-outdated':
      return status.reason ?? olderReason(status)
  }
  // Kettu's own package is not in its data folder yet.
  return awaitsPackage(status) ? { kind: 'not-installed' } : null
}

/**
 * Its program, or Kettu's install of it, is on the machine, even one that cannot run, such as one
 * too old or a package waiting for Node.js.
 */
export function programHere(status: AgentStatus): boolean {
  if (hasProgram(status)) return true
  const kind = harnessReason(status)?.kind
  if (!kind || kind === 'not-installed' || kind === 'no-version') return false
  return !!(status.package?.installed || status.binaryOverride)
}

/** The short state of a reason. */
export function reasonLabel(reason: HarnessReason): string {
  const t = i18n.t.bind(i18n)
  switch (reason.kind) {
    case 'not-installed':
      return t('agents:problem.notInstalled')
    case 'needs-node':
      return reason.minimum
        ? t('agents:problem.needsNodeAt', { version: reason.minimum })
        : t('agents:problem.needsNode')
    case 'needs-npm':
      return t('agents:problem.needsNpm')
    case 'needs-uv':
      return reason.minimum
        ? t('agents:problem.needsUvAt', { version: reason.minimum })
        : t('agents:problem.needsUv')
    case 'too-old':
      return reason.minimum
        ? t('agents:problem.tooOldAt', { version: reason.minimum })
        : t('agents:problem.tooOld')
    case 'cannot-run':
      return t('agents:problem.cannotRun')
    case 'no-version':
      return t('agents:problem.noVersion')
  }
}

/** The short state without its version, where little room is left, as on a menu's rail. */
export function shortLabel(reason: HarnessReason): string {
  switch (reason.kind) {
    case 'needs-node':
    case 'needs-uv':
      return reasonLabel({ ...reason, minimum: null })
    case 'too-old':
      return reasonLabel({ ...reason, minimum: '' })
    default:
      return reasonLabel(reason)
  }
}

function fixOf(status: AgentStatus, reason: HarnessReason): ProblemFix | null {
  switch (reason.kind) {
    case 'not-installed':
      return 'install'
    case 'needs-node':
      return 'node'
    case 'needs-npm':
      return 'npm'
    case 'needs-uv':
      return 'uv'
    case 'too-old':
      return 'update'
    case 'cannot-run':
      return status.program || status.binaryCommand ? 'choose' : null
    case 'no-version':
      return null
  }
}

/** Why the harness cannot run, as every surface says it, or null when it can. */
export function harnessProblem(status: AgentStatus): HarnessProblem | null {
  const reason = harnessReason(status)
  if (!reason) return null
  const label = reasonLabel(reason)
  const text =
    reason.kind === 'cannot-run' && reason.why
      ? i18n.t('agents:problem.cannotRunWhy', { why: reason.why })
      : label
  return { reason, label, text, fix: fixOf(status, reason) }
}

/**
 * The reason several agents share, said once: Node.js or uv at the newest minimum among them,
 * which serves them all, and a too old program without a version when theirs differ.
 */
export function sharedReason(reasons: HarnessReason[]): HarnessReason | null {
  const [first] = reasons
  if (!first) return null
  const newest = (values: (string | null)[]) =>
    values.reduce<string | null>((top, v) => (v && (!top || newer(v, top)) ? v : top), null)
  switch (first.kind) {
    case 'needs-node':
    case 'needs-uv': {
      const same = reasons.filter((r) => r.kind === first.kind) as (typeof first)[]
      return { ...first, minimum: newest(same.map((r) => r.minimum)), installed: null }
    }
    case 'too-old':
      return reasons.every((r) => r.kind === 'too-old' && r.minimum === first.minimum)
        ? first
        : { kind: 'too-old', minimum: '', installed: null }
    case 'cannot-run':
      return { kind: 'cannot-run', why: '' }
    default:
      return first
  }
}

/** Whether dotted version `a` is newer than `b`. */
function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/**
 * Which copy of the harness's program runs, or would once it can: the one picked in Settings, the
 * user's own with how it was installed, or Kettu's. Null while there is none.
 */
export function programCopy(status: AgentStatus): string | null {
  const t = i18n.t.bind(i18n)
  if (status.binaryOverride) return t('agents:copy.chosen')
  if (status.cli?.installed) {
    const method = status.cli.method
    return method
      ? t('agents:copy.ownWith', { method: t(`settings:harnesses.methods.${method}`) })
      : t('agents:copy.own')
  }
  if (status.release) return t('agents:copy.kettu')
  if (status.package && !status.package.isSdk) {
    return status.package.installed ? t('agents:copy.kettu') : null
  }
  return status.binaryCommand && status.binaryPath ? t('agents:copy.own') : null
}
