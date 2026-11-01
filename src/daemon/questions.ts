// The questions a CLI command asks on the terminal, such as kettu pair's whether to add a device.

import { createInterface, type Interface } from 'node:readline'

export interface Questions {
  /** Asks with `initial` typed for the owner to edit; null once input ends. */
  ask(question: string, initial?: string): Promise<string | null>
  /** Lets go of the input, so the command can exit. */
  close(): void
}

/**
 * Questions on one readline for the whole command, opened at the first one. A readline reads
 * ahead, so one per question would lose the lines it read past its own answer, as piped answers.
 */
export function terminalQuestions(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  output: NodeJS.WritableStream,
): Questions {
  let lines: Interface | null = null
  let ended = false
  const ahead: string[] = []
  let pending: ((answer: string | null) => void) | null = null

  const answer = (value: string | null): void => {
    const resolve = pending
    pending = null
    resolve?.(value)
  }

  const open = (): Interface => {
    if (lines) return lines
    const opened = createInterface({ input, output })
    // Lines that come while no question waits answer the next ones.
    opened.on('line', (line) => ahead.push(line))
    opened.on('close', () => {
      ended = true
      answer(null)
    })
    opened.on('SIGINT', () => {
      const asking = pending !== null
      opened.close()
      // The terminal stays raw between questions, so Ctrl+C there goes to the command as usual.
      if (!asking) process.kill(process.pid, 'SIGINT')
    })
    lines = opened
    return opened
  }

  return {
    ask(question, initial) {
      if (ended) return Promise.resolve(ahead.shift() ?? null)
      const opened = open()
      // Typed ahead only on a terminal; piped input would be read after it on the same line.
      const typed = input.isTTY === true
      const prompt = initial && !typed ? `${question}[${initial}] ` : question
      const next = ahead.shift()
      if (next !== undefined) {
        output.write(prompt)
        return Promise.resolve(next)
      }
      return new Promise<string | null>((resolve) => {
        pending = resolve
        opened.question(prompt, answer)
        if (initial && typed) opened.write(initial)
      })
    },
    close() {
      lines?.close()
    },
  }
}
