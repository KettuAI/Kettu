// Temporary: times the real process tools on each CI platform, to choose their limits.

import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processControl } from './process-tree'

const ms = (start: number) => Math.round(performance.now() - start)

describe('process tool timings (temporary)', () => {
  it('lists and ends processes', { timeout: 180_000 }, async () => {
    const control = processControl(process.platform)
    const lists: number[] = []
    for (let i = 0; i < 12; i++) {
      const start = performance.now()
      const rows = await control.list()
      lists.push(ms(start))
      expect(rows.length).toBeGreaterThan(0)
    }
    const kills: number[] = []
    const gone: number[] = []
    if (process.platform === 'win32') {
      for (let i = 0; i < 6; i++) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        let start = performance.now()
        await control.taskkill([child.pid!])
        kills.push(ms(start))
        start = performance.now()
        await control.taskkill([child.pid!])
        gone.push(ms(start))
      }
    }
    process.stderr.write(
      `[measure-79] ${process.platform} list ${lists.join(' ')} | taskkill live ${kills.join(' ')} | taskkill gone ${gone.join(' ')}\n`,
    )
  })
})
