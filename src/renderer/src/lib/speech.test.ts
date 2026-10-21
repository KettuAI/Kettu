import { describe, expect, it } from 'vitest'
import { speakable } from './speech'

describe('speakable', () => {
  it('drops code blocks, link targets and formatting marks', () => {
    expect(
      speakable(
        '## Done\n\nI fixed **the clock** in `src/clock.ts`, see [the docs](https://x.dev).\n\n```ts\nconst a = 1\n```\n- one\n- two',
      ),
    ).toBe('Done I fixed the clock in src/clock.ts, see the docs. one two')
  })
})
