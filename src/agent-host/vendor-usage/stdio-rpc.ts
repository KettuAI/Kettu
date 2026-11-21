import { spawn } from 'node:child_process'
import { t } from '../i18n'

interface RpcCall {
  method: string
  params?: unknown
}

/** Runs one short-lived Content-Length JSON-RPC server request, then closes its process. */
export async function requestOverStdio(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  calls: RpcCall[],
  timeoutMs = 20_000,
): Promise<unknown> {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  let buffer = Buffer.alloc(0)
  let next = 0
  let requestId = 0
  let done = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const result = new Promise<unknown>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (done) return
      done = true
      reject(error)
    }
    const send = (): void => {
      if (next >= calls.length) {
        done = true
        resolve(undefined)
        return
      }
      requestId += 1
      const call = calls[next++]!
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: call.method,
          params: call.params ?? {},
        }),
      )
      child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
      child.stdin.write(body)
    }
    const parse = (): void => {
      while (true) {
        const boundary = buffer.indexOf('\r\n\r\n')
        if (boundary < 0) return
        const header = buffer.subarray(0, boundary).toString('ascii')
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
        if (!Number.isFinite(length) || length < 0)
          return fail(new Error(t('usageRead.rpc.badFrame')))
        if (buffer.length < boundary + 4 + length) return
        const message = JSON.parse(
          buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8'),
        ) as {
          id?: number
          result?: unknown
          error?: { message?: string }
        }
        buffer = buffer.subarray(boundary + 4 + length)
        if (message.id !== requestId) continue
        if (message.error)
          return fail(new Error(message.error.message ?? t('usageRead.rpc.failed')))
        if (next === calls.length) {
          done = true
          resolve(message.result)
        } else send()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        parse()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.once('error', (error) => fail(error))
    child.once('exit', (code) => {
      if (!done) fail(new Error(t('usageRead.rpc.exited', { code: String(code) })))
    })
    timer = setTimeout(() => fail(new Error(t('usageRead.rpc.timedOut'))), timeoutMs)
    send()
  })
  try {
    return await result
  } finally {
    if (timer) clearTimeout(timer)
    child.stdin.end()
    if (child.exitCode === null) child.kill()
  }
}
