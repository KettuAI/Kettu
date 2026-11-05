// Validators for every request on the device host port: small hand-written type guards.

import {
  DEVICE_FLOW,
  type DeviceButton,
  type DeviceInput,
  type DeviceMethod,
  type DeviceParams,
} from '@shared/device-host'

export class ValidationError extends Error {}

const MAX_ID = 256
const MAX_SEQ = Number.MAX_SAFE_INTEGER
const DEVICE_ID = /^(ios-sim|ios|android|avd):[\w.:\-@]+$/
const KEY_CODE = /^[A-Za-z0-9]{1,32}$/
const BUTTONS: readonly DeviceButton[] = [
  'home',
  'lock',
  'volumeUp',
  'volumeDown',
  'back',
  'recents',
  'rotate',
]

type Params = Record<string, unknown>

function object(raw: unknown, allowed: string[]): Params {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('params must be an object')
  }
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key))
  if (unknown) throw new ValidationError(`Unknown parameter "${unknown}"`)
  return raw as Params
}

function string(params: Params, key: string, max: number): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ValidationError(`"${key}" must be a non-empty string of at most ${max} characters`)
  }
  return value
}

function deviceId(params: Params): string {
  const value = string(params, 'deviceId', MAX_ID)
  if (!DEVICE_ID.test(value)) throw new ValidationError('"deviceId" is not a device id')
  return value
}

function fraction(params: Params, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`"${key}" must be a number from 0 to 1`)
  }
  return value
}

function delta(params: Params, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new ValidationError(`"${key}" must be a number from -10000 to 10000`)
  }
  return value
}

export function input(raw: unknown): DeviceInput {
  if (typeof raw !== 'object' || raw === null)
    throw new ValidationError('"input" must be an object')
  const type = (raw as Params).type
  switch (type) {
    case 'touch': {
      const params = object(raw, ['type', 'phase', 'x', 'y', 'finger'])
      const phase = params.phase
      if (phase !== 'begin' && phase !== 'move' && phase !== 'end') {
        throw new ValidationError('"phase" must be begin, move or end')
      }
      const finger = params.finger
      if (
        finger !== undefined &&
        (typeof finger !== 'number' || !Number.isInteger(finger) || finger < 0 || finger > 9)
      ) {
        throw new ValidationError('"finger" must be an integer from 0 to 9')
      }
      return {
        type,
        phase,
        x: fraction(params, 'x'),
        y: fraction(params, 'y'),
        ...(finger !== undefined ? { finger } : {}),
      }
    }
    case 'scroll': {
      const params = object(raw, ['type', 'x', 'y', 'dx', 'dy'])
      return {
        type,
        x: fraction(params, 'x'),
        y: fraction(params, 'y'),
        dx: delta(params, 'dx'),
        dy: delta(params, 'dy'),
      }
    }
    case 'key': {
      const params = object(raw, ['type', 'phase', 'code'])
      if (params.phase !== 'down' && params.phase !== 'up') {
        throw new ValidationError('"phase" must be down or up')
      }
      const code = string(params, 'code', 32)
      if (!KEY_CODE.test(code)) throw new ValidationError('"code" is not a key code')
      return { type, phase: params.phase, code }
    }
    case 'text': {
      const params = object(raw, ['type', 'text'])
      const text = string(params, 'text', DEVICE_FLOW.maxTextBytes)
      // Newlines and tabs are text; other control characters could act as keys.
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
        throw new ValidationError('"text" must not contain control characters')
      }
      return { type, text }
    }
    case 'button': {
      const params = object(raw, ['type', 'button'])
      if (!BUTTONS.includes(params.button as DeviceButton)) {
        throw new ValidationError('"button" is not a device button')
      }
      return { type, button: params.button as DeviceButton }
    }
    default:
      throw new ValidationError('"input.type" is not an input')
  }
}

function sessionId(params: Params): string {
  return string(params, 'sessionId', MAX_ID)
}

export const validators: { [M in DeviceMethod]: (raw: unknown) => DeviceParams<M> } = {
  'devices.environment': (raw) => {
    object(raw ?? {}, [])
    return {}
  },
  'devices.list': (raw) => {
    const params = object(raw ?? {}, ['sessionId'])
    return params.sessionId === undefined ? {} : { sessionId: sessionId(params) }
  },
  'devices.open': (raw) => {
    const params = object(raw, ['deviceId', 'sessionId'])
    return { deviceId: deviceId(params), sessionId: sessionId(params) }
  },
  'devices.close': (raw) => {
    const params = object(raw, ['deviceId', 'sessionId', 'shutdown'])
    if (params.shutdown !== undefined && typeof params.shutdown !== 'boolean') {
      throw new ValidationError('"shutdown" must be a boolean')
    }
    return {
      deviceId: deviceId(params),
      sessionId: sessionId(params),
      ...(params.shutdown !== undefined ? { shutdown: params.shutdown as boolean } : {}),
    }
  },
  'devices.watch': (raw) => ({ deviceId: deviceId(object(raw, ['deviceId'])) }),
  'devices.unwatch': (raw) => ({ deviceId: deviceId(object(raw, ['deviceId'])) }),
  'devices.ack': (raw) => {
    const params = object(raw, ['deviceId', 'seq'])
    const seq = params.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq > MAX_SEQ) {
      throw new ValidationError('"seq" must be a sequence number')
    }
    return { deviceId: deviceId(params), seq }
  },
  'devices.input': (raw) => {
    const params = object(raw, ['deviceId', 'input'])
    return { deviceId: deviceId(params), input: input(params.input) }
  },
  'devices.handBack': (raw) => ({ deviceId: deviceId(object(raw, ['deviceId'])) }),
  'devices.stopAgent': (raw) => ({ deviceId: deviceId(object(raw, ['deviceId'])) }),
  'devices.screenshot': (raw) => ({ deviceId: deviceId(object(raw, ['deviceId'])) }),
}
