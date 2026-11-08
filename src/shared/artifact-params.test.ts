import { describe, expect, it } from 'vitest'
import { paramCss, paramsRange, parseParams, withParamValues } from './artifact-params'

const page = `<!DOCTYPE html><html><head>
<script type="application/json" data-kettu-params>
{"accent": {"type": "color", "label": "Accent", "value": "#0060e2"},
 "density": {"type": "choice", "options": ["comfortable", "compact"], "value": "comfortable"},
 "radius": {"type": "number", "min": 0, "max": 24, "unit": "px", "value": 8},
 "avatars": {"type": "boolean", "value": true},
 "Bad Name": {"type": "text", "value": "x"},
 "broken": {"type": "color", "value": "blue"}}
</script></head><body></body></html>`

describe('page parameters', () => {
  it('keep what Kettu can show, in their written order', () => {
    const range = paramsRange(page)!
    const params = parseParams(page.slice(range.start, range.end))
    expect(params.map((p) => [p.name, p.type])).toEqual([
      ['accent', 'color'],
      ['density', 'choice'],
      ['radius', 'number'],
      ['avatars', 'boolean'],
    ])
    expect(paramCss(params[2]!, 12)).toEqual({ variable: '12px', attribute: '12' })
  })

  it('write new values into the page, refusing a value a parameter does not take', () => {
    const next = withParamValues(page, { accent: '#7653c9', radius: 12 })
    const range = paramsRange(next)!
    const params = parseParams(next.slice(range.start, range.end))
    expect(params.find((p) => p.name === 'accent')!.value).toBe('#7653c9')
    expect(params.find((p) => p.name === 'radius')!.value).toBe(12)
    expect(next.endsWith('</script></head><body></body></html>')).toBe(true)
    expect(() => withParamValues(page, { radius: 99 })).toThrow()
    expect(() => withParamValues(page, { density: 'tight' })).toThrow()
    expect(() => withParamValues(page, { missing: 1 })).toThrow()
    expect(() => withParamValues('<p>none</p>', { accent: '#000' })).toThrow()
  })

  it('never let a written value end the script', () => {
    const text = page.replace(
      '"Bad Name": {"type": "text", "value": "x"}',
      '"title": {"type": "text", "value": "x"}',
    )
    const next = withParamValues(text, { title: '</script><script>alert(1)</script>' })
    expect(next.match(/<\/script/gi)).toHaveLength(1)
  })
})
