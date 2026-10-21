// Validators for every request on the terminal host port: small hand-written type guards.

import {
  TERMINAL_FLOW,
  type TerminalCommand,
  type TerminalMethod,
  type TerminalParams,
} from '@shared/terminal-host'

export class ValidationError extends Error {}

const MAX_ID = 128
const MAX_PATH = 4096
const MAX_COMMAND = 16 * 1024
const MAX_SIZE = 1000
const MAX_ACK = 1_000_000_000

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

function integer(params: Params, key: string, min: number, max: number): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`"${key}" must be an integer from ${min} to ${max}`)
  }
  return value
}

function projectPath(params: Params): string {
  const value = string(params, 'projectPath', MAX_PATH)
  if (value.includes('\0')) throw new ValidationError('"projectPath" must not contain NUL')
  return value
}

function command(raw: unknown): TerminalCommand {
  const params = object(raw, ['text', 'run'])
  const text = string(params, 'text', MAX_COMMAND)
  // Tabs and newlines are part of a command; any other control character could act as a key.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
    throw new ValidationError('"command.text" must not contain control characters')
  }
  if (typeof params.run !== 'boolean') throw new ValidationError('"command.run" must be a boolean')
  return { text, run: params.run }
}

type Validators = { [M in TerminalMethod]: (raw: unknown) => TerminalParams<M> }

export const validators: Validators = {
  'terminals.create': (raw) => {
    const params = object(raw, ['projectPath', 'cols', 'rows', 'command'])
    return {
      projectPath: projectPath(params),
      cols: integer(params, 'cols', 1, MAX_SIZE),
      rows: integer(params, 'rows', 1, MAX_SIZE),
      ...(params.command === undefined ? {} : { command: command(params.command) }),
    }
  },
  'terminals.list': (raw) => {
    const params = object(raw ?? {}, ['projectPath'])
    return params.projectPath === undefined ? {} : { projectPath: projectPath(params) }
  },
  'terminals.attach': (raw) => ({ id: string(object(raw, ['id']), 'id', MAX_ID) }),
  'terminals.input': (raw) => {
    const params = object(raw, ['id', 'data'])
    const id = string(params, 'id', MAX_ID)
    const data = params.data
    if (typeof data !== 'string' || Buffer.byteLength(data) > TERMINAL_FLOW.maxInputBytes) {
      throw new ValidationError(
        `"data" must be a string of at most ${TERMINAL_FLOW.maxInputBytes} bytes`,
      )
    }
    return { id, data }
  },
  'terminals.resize': (raw) => {
    const params = object(raw, ['id', 'cols', 'rows'])
    return {
      id: string(params, 'id', MAX_ID),
      cols: integer(params, 'cols', 1, MAX_SIZE),
      rows: integer(params, 'rows', 1, MAX_SIZE),
    }
  },
  'terminals.ack': (raw) => {
    const params = object(raw, ['id', 'chars'])
    return { id: string(params, 'id', MAX_ID), chars: integer(params, 'chars', 0, MAX_ACK) }
  },
  'terminals.kill': (raw) => ({ id: string(object(raw, ['id']), 'id', MAX_ID) }),
  'terminals.restart': (raw) => ({ id: string(object(raw, ['id']), 'id', MAX_ID) }),
}
