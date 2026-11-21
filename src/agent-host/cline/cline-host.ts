// The process that runs Cline's SDK for one Agent: started by the agent host as
// `<node> <this file> <the SDK's entry module> [<variable>...]`, it speaks JSON-RPC with it over
// stdio, one message per line. The variables named are the ones that only started this process,
// such as the one that makes Electron run as Node.js: they are dropped before the SDK loads, so no
// command the agent runs inherits them. It is never imported.

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Host, HostError, messageOf } from './host-sessions'
import { ERROR, METHOD } from './protocol'
import type { Sdk } from './sdk'

type Id = number | string

// Only frames go to stdout: whatever the SDK or a package it loads prints goes to stderr.
const frame = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write

function post(message: Record<string, unknown>): void {
  frame(`${JSON.stringify(message)}\n`)
}

let nextId = 1
const waiting = new Map<Id, { resolve(value: unknown): void; reject(error: Error): void }>()

function ask<T>(method: string, params: unknown): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
    post({ jsonrpc: '2.0', id, method, params })
  })
}

async function main(): Promise<void> {
  const [entry, ...own] = process.argv.slice(2)
  if (!entry) throw new Error('No SDK entry module was given')
  for (const name of own) delete process.env[name]
  const sdk = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Sdk
  const host = new Host(sdk, {
    ask,
    notify: (method, params) => post({ jsonrpc: '2.0', method, params }),
    log: (text) => void process.stderr.write(`cline-host: ${text}\n`),
  })
  let ending = false
  const end = async (): Promise<void> => {
    if (ending) return
    ending = true
    await host.shutdown().catch(() => {})
    process.exit(0)
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message: { id?: Id; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (typeof message.method !== 'string') {
      const pending = message.id === undefined ? undefined : waiting.get(message.id)
      if (!pending) return
      waiting.delete(message.id!)
      if (message.error) pending.reject(new Error(messageOf(message.error)))
      else pending.resolve(message.result)
      return
    }
    const { id, method } = message
    void host.serve(method, message.params).then(
      (result) => {
        if (id !== undefined) post({ jsonrpc: '2.0', id, result: result ?? {} })
        if (method === METHOD.shutdown) void end()
      },
      (error: unknown) => {
        if (id === undefined) return
        const code = error instanceof HostError ? error.code : ERROR.failed
        const reason = error instanceof HostError ? error.reason : undefined
        post({
          jsonrpc: '2.0',
          id,
          error: {
            code,
            message: messageOf(error),
            ...(reason ? { data: { reason } } : {}),
          },
        })
      },
    )
  })
  // The agent host is gone, or closed the pipe to stop this process.
  lines.on('close', () => void end())
}

main().catch((error: unknown) => {
  process.stderr.write(`cline-host: ${messageOf(error)}\n`)
  process.exit(1)
})
