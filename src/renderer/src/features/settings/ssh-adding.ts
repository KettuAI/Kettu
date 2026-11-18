// The state of Add host's SSH tab: the config's machines, the queue that adds the checked ones
// at most three at a time, and the form for a machine typed by hand.

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TFunction } from 'i18next'
import {
  parseIdentityFile,
  parseSshPort,
  parseSshTarget,
  type HostPairingFailure,
  type HostPairingState,
  type HostStatus,
  type SshAddress,
  type SshConfigHost,
  type SshConfigHosts,
  type SshStep,
} from '@shared/remote/hosts'

/** `user@hostname`, the port when it is not 22, and the jump hosts. */
export function machineLine(t: TFunction<'settings'>, host: SshConfigHost): string {
  const at = `${host.user}@${host.hostname}${host.port === 22 ? '' : `:${host.port}`}`
  return host.proxyJump ? `${at} · ${t('hosts.add.ssh.config.via', { jump: host.proxyJump })}` : at
}

/** The machines whose alias, user, host name or jump hosts hold what the filter says. */
export function matchMachines(hosts: SshConfigHost[], query: string): SshConfigHost[] {
  const words = query.trim().toLowerCase()
  if (!words) return hosts
  return hosts.filter((host) =>
    [host.alias, host.user, host.hostname, host.proxyJump ?? ''].some((text) =>
      text.toLowerCase().includes(words),
    ),
  )
}

/** Why Add host shows no host: what pairing said, or what kept it from starting. */
export type AddHostFailure = HostPairingFailure | 'self' | 'unavailable'

/** Adding one machine over SSH: the steps it went through, the last one the current one. */
export type SshAddStep =
  | { kind: 'enter' }
  | { kind: 'working'; steps: SshStep[] }
  | { kind: 'failed'; steps: SshStep[]; reason: AddHostFailure; detail: string | null }
  | { kind: 'added'; host: HostStatus }

/** A machine of the config once Add took it: waiting for a free place, then as one address. */
export type SshRun = { kind: 'waiting' } | Exclude<SshAddStep, { kind: 'enter' }>

/** How many of the checked machines are added at once; the rest wait. */
const AT_ONCE = 3

export const stepsOf = (step: SshAddStep | SshRun | undefined): SshStep[] =>
  step?.kind === 'working' || step?.kind === 'failed' ? step.steps : []

/** The step a pairing state names, without the state's own field. */
function sshStep(state: Extract<HostPairingState, { state: 'ssh' }>): SshStep {
  switch (state.step) {
    case 'installing':
      return { step: state.step, version: state.version }
    case 'updating':
      return { step: state.step, from: state.from, to: state.to }
    default:
      return { step: state.step }
  }
}

/** A machine typed by hand, as the form holds it. */
export interface SshDraft {
  address: string
  port: string
  signIn: 'agent' | 'key'
  keyFile: string
}

export const draftOf = (address?: SshAddress): SshDraft => ({
  address: address?.target ?? '',
  port: address?.sshPort === undefined ? '' : String(address.sshPort),
  signIn: address?.identityFile ? 'key' : 'agent',
  keyFile: address?.identityFile ?? '',
})

/** What is wrong with each field of the form, apart from being left empty. */
export function draftProblems(draft: SshDraft): { address: boolean; port: boolean; key: boolean } {
  const port = draft.port.trim()
  const key = draft.keyFile.trim()
  return {
    address: draft.address.trim() !== '' && parseSshTarget(draft.address) === null,
    port: port !== '' && (!/^\d+$/.test(port) || parseSshPort(Number(port)) === null),
    key: draft.signIn === 'key' && key !== '' && parseIdentityFile(key) === null,
  }
}

/** The address the form gives, or null while a field is missing or wrong. */
export function draftAddress(draft: SshDraft): SshAddress | null {
  const target = parseSshTarget(draft.address)
  const problems = draftProblems(draft)
  if (!target || problems.port || problems.key) return null
  const port = draft.port.trim()
  const key = draft.keyFile.trim()
  if (draft.signIn === 'key' && !key) return null
  return {
    target,
    ...(port ? { sshPort: Number(port) } : {}),
    ...(draft.signIn === 'key' ? { identityFile: key } : {}),
  }
}

/** The command that logs in as Kettu does, for the user to try in a terminal. */
export function sshCommand(address: SshAddress): string {
  const quote = (text: string): string =>
    /^[\w./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
  return [
    'ssh',
    ...(address.sshPort === undefined ? [] : ['-p', String(address.sshPort)]),
    ...(address.identityFile === undefined ? [] : ['-i', quote(address.identityFile)]),
    address.target,
  ].join(' ')
}

export interface SshAdding {
  /** The config's machines, or null while they are first read. */
  config: SshConfigHosts | null
  read: () => Promise<void>
  checked: ReadonlySet<string>
  setChecked: (alias: string, on: boolean) => void
  runs: Readonly<Record<string, SshRun>>
  /** Adds the checked machines, in the list's order. */
  addChecked: () => void
  retry: (alias: string) => void
  view: 'list' | 'manual'
  setView: (view: 'list' | 'manual') => void
  draft: SshDraft
  setDraft: (draft: SshDraft) => void
  manual: SshAddStep
  /** The address being added by hand, or the last one tried. */
  manualAddress: SshAddress | null
  startManual: () => void
  /** Something is being added, which a click outside the dialog should not end. */
  busy: boolean
  /** Takes a pairing's progress when it is one of this tab's; false otherwise. */
  take: (pairId: number, state: HostPairingState) => boolean
  /** Add host closed: what is being added ends, and answers on their way are let go. */
  abandon: () => void
}

/**
 * The SSH tab's state, kept by Add host so switching tabs leaves it going. The config is read
 * the first time the tab shows, and again only on Refresh. `early` holds the progress of
 * pairings main has not named yet, which Add host keeps for both tabs.
 */
export function useSshAdding({
  active,
  prefill,
  early,
}: {
  active: boolean
  prefill?: SshAddress
  early: RefObject<Map<number, HostPairingState[]>>
}): SshAdding {
  const [config, setConfig] = useState<SshConfigHosts | null>(null)
  const [checked, setCheckedSet] = useState<ReadonlySet<string>>(new Set())
  const [runs, setRuns] = useState<Readonly<Record<string, SshRun>>>({})
  const [view, setView] = useState<'list' | 'manual'>(prefill ? 'manual' : 'list')
  const [draft, setDraftState] = useState(() => draftOf(prefill))
  const [manual, setManual] = useState<SshAddStep>({ kind: 'enter' })
  const [manualAddress, setManualAddress] = useState<SshAddress | null>(null)
  const readRound = useRef(0)
  const asked = useRef(false)

  // One set of handlers for the dialog's life: they reach only these locals and state setters.
  const [engine] = useState(() => {
    const rows = new Map<number, string>()
    const queue: string[] = []
    let running = 0
    let generation = 0
    let manualPair: number | null = null
    let manualAttempt = 0

    const setRun = (alias: string, next: (now: SshRun | undefined) => SshRun): void =>
      setRuns((now) => ({ ...now, [alias]: next(now[alias]) }))

    const caughtUp = (pairId: number, take: (state: HostPairingState) => void): void => {
      const waiting = early.current.get(pairId) ?? []
      early.current.delete(pairId)
      for (const state of waiting) take(state)
    }

    const ended = (): void => {
      running--
      pump()
    }

    const takeRow = (pairId: number, alias: string, state: HostPairingState): void => {
      if (state.state === 'added') {
        rows.delete(pairId)
        setRun(alias, () => ({ kind: 'added', host: state.host }))
        ended()
      } else if (state.state === 'failed') {
        rows.delete(pairId)
        const { reason } = state
        const detail = state.detail ?? null
        setRun(alias, (now) => ({ kind: 'failed', steps: stepsOf(now), reason, detail }))
        ended()
      } else if (state.state === 'ssh') {
        const step = sshStep(state)
        setRun(alias, (now) => ({ kind: 'working', steps: [...stepsOf(now), step] }))
      }
    }

    const startRow = (alias: string): void => {
      const round = generation
      running++
      setRun(alias, () => ({ kind: 'working', steps: [] }))
      const failed = (reason: AddHostFailure): void => {
        setRun(alias, () => ({ kind: 'failed', steps: [], reason, detail: null }))
        ended()
      }
      window.kettu.hosts.addSsh({ target: alias }).then(
        (started) => {
          if (round !== generation) {
            if (started.kind === 'pairing') void window.kettu.hosts.closePairing(started.pairId)
            return
          }
          if (started.kind !== 'pairing') {
            return failed(started.kind === 'unavailable' ? 'unavailable' : 'ssh_failed')
          }
          rows.set(started.pairId, alias)
          caughtUp(started.pairId, (state) => takeRow(started.pairId, alias, state))
        },
        () => {
          if (round === generation) failed('ssh_failed')
        },
      )
    }

    function pump(): void {
      while (running < AT_ONCE && queue.length > 0) startRow(queue.shift()!)
    }

    const enqueue = (aliases: string[]): void => {
      for (const alias of aliases) {
        if (queue.includes(alias)) continue
        queue.push(alias)
        setRun(alias, () => ({ kind: 'waiting' }))
      }
      pump()
    }

    const takeManual = (state: HostPairingState): void => {
      if (state.state === 'added' || state.state === 'failed') manualPair = null
      if (state.state === 'added') setManual({ kind: 'added', host: state.host })
      else if (state.state === 'failed') {
        const { reason } = state
        const detail = state.detail ?? null
        setManual((now) => ({ kind: 'failed', steps: stepsOf(now), reason, detail }))
      } else if (state.state === 'ssh') {
        const step = sshStep(state)
        setManual((now) => ({ kind: 'working', steps: [...stepsOf(now), step] }))
      }
    }

    const closeManual = (): void => {
      const pairId = manualPair
      manualPair = null
      if (pairId !== null) void window.kettu.hosts.closePairing(pairId)
    }

    const startManual = (address: SshAddress): void => {
      closeManual()
      const attempt = ++manualAttempt
      setManualAddress(address)
      setManual({ kind: 'working', steps: [] })
      const failed = (reason: AddHostFailure): void =>
        setManual({ kind: 'failed', steps: [], reason, detail: null })
      window.kettu.hosts.addSsh(address).then(
        (started) => {
          if (attempt !== manualAttempt) {
            if (started.kind === 'pairing') void window.kettu.hosts.closePairing(started.pairId)
            return
          }
          if (started.kind === 'invalid') return setManual({ kind: 'enter' })
          if (started.kind !== 'pairing') return failed(started.kind)
          manualPair = started.pairId
          caughtUp(started.pairId, takeManual)
        },
        () => {
          if (attempt === manualAttempt) failed('ssh_failed')
        },
      )
    }

    return {
      enqueue,
      startManual,
      take: (pairId: number, state: HostPairingState): boolean => {
        const alias = rows.get(pairId)
        if (alias !== undefined) takeRow(pairId, alias, state)
        else if (pairId === manualPair) takeManual(state)
        else return false
        return true
      },
      abandon: (): void => {
        generation++
        manualAttempt++
        queue.length = 0
        running = 0
        for (const pairId of rows.keys()) void window.kettu.hosts.closePairing(pairId)
        rows.clear()
        closeManual()
      },
    }
  })

  const read = async (): Promise<void> => {
    const round = ++readRound.current
    let result: SshConfigHosts
    try {
      result = await window.kettu.hosts.sshConfig()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      result = { state: 'failed', reason: 'unreadable', path: '~/.ssh/config', detail }
    }
    if (round === readRound.current) setConfig(result)
  }

  useEffect(() => {
    if (!active || asked.current) return
    asked.current = true
    void read()
  }, [active])

  const listed = config?.state === 'ok' ? config.hosts : []
  const busy =
    manual.kind === 'working' ||
    Object.values(runs).some((run) => run.kind === 'waiting' || run.kind === 'working')
  return {
    config,
    read,
    checked,
    setChecked: (alias, on) =>
      setCheckedSet((now) => {
        const next = new Set(now)
        if (on) next.add(alias)
        else next.delete(alias)
        return next
      }),
    runs,
    addChecked: () => {
      engine.enqueue(listed.filter((host) => checked.has(host.alias)).map((host) => host.alias))
      setCheckedSet(new Set())
    },
    retry: (alias) => engine.enqueue([alias]),
    view,
    setView,
    draft,
    setDraft: (next) => {
      setDraftState(next)
      // A changed address goes back to asking, without what the last try said.
      if (manual.kind === 'failed') setManual({ kind: 'enter' })
    },
    manual,
    manualAddress,
    startManual: () => {
      const address = draftAddress(draft)
      if (address) engine.startManual(address)
    },
    busy,
    take: engine.take,
    abandon: engine.abandon,
  }
}
