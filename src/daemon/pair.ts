// `kettu pair`: a pairing code in the terminal, as Add device shows it in the app, and the
// question whether to add the device that used it, with its name to edit.

import { renderUnicodeCompact } from 'uqr'
import type { PairingDevice, PairingEnd, PairingState } from '@shared/remote/pairing'
import { normalizeDeviceName } from '@shared/remote/device'
import type { ControlClient } from './control'

export interface PairTerminal {
  write(text: string): void
  /** Output is a terminal, where the time left counts down in place. */
  live: boolean
  /** Asks a question with `initial` already typed, for the owner to edit; null once input ends. */
  ask(question: string, initial?: string): Promise<string | null>
}

const ENDS: Record<PairingEnd, string> = {
  expired: 'The code expired: no device used it within 5 minutes. Run kettu pair for a new one.',
  attempts:
    'A device used a wrong code 5 times, so the code is void. Show the next one only to your own device.',
  rejected: 'You rejected the device, so the code is void.',
  closed: 'The code was closed.',
  replaced: 'Another pairing code replaced this one.',
  stopped: 'Remote access stopped, and the code with it.',
}

const KINDS: Record<string, string> = { ios: 'iOS app', desktop: 'Desktop app', web: 'Web' }

/** The QR code black on white whatever the terminal's colors, so a camera reads it. */
export function terminalQr(text: string): string {
  return renderUnicodeCompact(text, { ecc: 'L', border: 2 })
    .split('\n')
    .map((line) => `\x1b[30;107m${line}\x1b[0m`)
    .join('\n')
}

/** "4:05" */
function timeLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function deviceLine(device: PairingDevice): string {
  return [KINDS[device.kind] ?? device.kind, device.model, device.platform]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Opens a code on `client` and talks the owner through it. Resolves with the exit code: 0 once a
 * device is added, 1 when the code ends without one, 130 when `signal` aborts.
 */
export function pairDevice(
  client: ControlClient,
  terminal: PairTerminal,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let codeId: number | null = null
    let ticker: ReturnType<typeof setInterval> | null = null
    let counting = false
    let settled = false

    const stopCounting = (): void => {
      if (ticker) clearInterval(ticker)
      ticker = null
      if (counting) terminal.write('\r\x1b[2K')
      counting = false
    }
    const finish = (code: number, line: string): void => {
      if (settled) return
      settled = true
      stopCounting()
      terminal.write(`${line}\n`)
      client.close()
      resolve(code)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      stopCounting()
      client.close()
      reject(error)
    }

    const waiting = (pairing: Extract<PairingState, { state: 'waiting' }>): void => {
      terminal.write(
        `${terminalQr(pairing.link)}\n\n` +
          'Scan it with Kettu on an iPhone or iPad. On another computer, paste the link in\n' +
          `Settings › Hosts › Add host:\n\n  ${pairing.link}\n\n` +
          'It adds one device, which must reach this computer directly: on the same network, the\n' +
          'same VPN, or at an address of your own.\n\n',
      )
      const line = (): string =>
        `Waiting for a device… the code expires in ${timeLeft(pairing.expiresAt - now())}.`
      if (!terminal.live) {
        terminal.write(`${line()}\n`)
        return
      }
      counting = true
      terminal.write(line())
      ticker = setInterval(() => terminal.write(`\r\x1b[2K${line()}`), 1000)
    }

    const confirm = async (device: PairingDevice): Promise<void> => {
      stopCounting()
      terminal.write(
        `\n${device.name} (${deviceLine(device)}) used the code.\n` +
          'Add it only if it is the device you just scanned with; one that merely saw the code\n' +
          'cannot connect unless you add it here. Rejecting voids the code.\n\n',
      )
      const add = await terminal.ask('Add this device? [y/N] ')
      if (add === null) return finish(1, '\nNo answer; the code is void.')
      if (!/^y(es)?$/i.test(add.trim())) {
        await client.call('pair.answer', { codeId: codeId!, add: false, name: '' })
        return
      }
      const typed = await terminal.ask('Name: ', device.name)
      if (typed === null) return finish(1, '\nNo answer; the code is void.')
      const name = normalizeDeviceName(typed) ?? device.name
      await client.call('pair.answer', { codeId: codeId!, add: true, name })
    }

    const show = (pairing: PairingState): void => {
      switch (pairing.state) {
        case 'waiting':
          return waiting(pairing)
        case 'confirm':
          return void confirm(pairing.device).catch(fail)
        case 'added':
          return finish(0, `Added ${pairing.device.name}; it can connect now.`)
        case 'void':
          return finish(1, ENDS[pairing.reason])
      }
    }

    signal.addEventListener('abort', () => finish(130, '\nStopped; the code is void.'), {
      once: true,
    })
    client.onClose(() => fail(new Error('The daemon closed the connection')))
    client.onEvent((event) => {
      if (event.type !== 'pairing' || settled) return
      // The code's events may come before the answer that names it.
      if (codeId !== null && event.codeId !== codeId) return
      codeId ??= event.codeId
      show(event.pairing)
    })
    client.call('pair.open', undefined).then(({ codeId: id }) => (codeId ??= id), fail)
  })
}
