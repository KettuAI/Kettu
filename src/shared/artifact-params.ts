// The parameters a canvas page declares for the user to tweak: a JSON object in a
// `<script type="application/json" data-kettu-params>` of the page, each entry a name and how it
// is set. The page runtime puts each value on the page's root as a CSS variable and an attribute;
// the canvas shows a control per parameter and writes new values back into that script.

export const PARAMS_ATTRIBUTE = 'data-kettu-params'
export const PARAMS_MAX = 24
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const LABEL_CHARS = 60
const TEXT_CHARS = 200
const OPTIONS_MAX = 20
const UNIT = /^[a-z%]{0,8}$/

export type ParamValue = string | number | boolean

interface Base {
  name: string
  label: string
}

export type PageParam =
  | (Base & { type: 'color'; value: string })
  | (Base & { type: 'text'; value: string })
  | (Base & { type: 'number'; value: number; min: number; max: number; step: number; unit: string })
  | (Base & { type: 'boolean'; value: boolean })
  | (Base & { type: 'choice'; value: string; options: string[] })

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One declared parameter, or null when it is not one Kettu can show. */
function paramOf(name: string, value: unknown): PageParam | null {
  if (!NAME.test(name) || !isRecord(value)) return null
  const label =
    typeof value.label === 'string' && value.label.trim() !== ''
      ? value.label.trim().slice(0, LABEL_CHARS)
      : name
  switch (value.type) {
    case 'color':
      return typeof value.value === 'string' && COLOR.test(value.value)
        ? { name, label, type: 'color', value: value.value }
        : null
    case 'text':
      return typeof value.value === 'string'
        ? { name, label, type: 'text', value: value.value.slice(0, TEXT_CHARS) }
        : null
    case 'number': {
      const num = (v: unknown, fallback: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : fallback
      const min = num(value.min, 0)
      const max = Math.max(min, num(value.max, 100))
      const step = Math.max(0.001, num(value.step, 1))
      const unit = typeof value.unit === 'string' && UNIT.test(value.unit) ? value.unit : ''
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
      return {
        name,
        label,
        type: 'number',
        value: Math.min(max, Math.max(min, value.value)),
        min,
        max,
        step,
        unit,
      }
    }
    case 'boolean':
      return typeof value.value === 'boolean'
        ? { name, label, type: 'boolean', value: value.value }
        : null
    case 'choice': {
      const options = Array.isArray(value.options)
        ? value.options
            .filter((o): o is string => typeof o === 'string' && o !== '')
            .map((o) => o.slice(0, LABEL_CHARS))
            .slice(0, OPTIONS_MAX)
        : []
      return typeof value.value === 'string' && options.includes(value.value)
        ? { name, label, type: 'choice', value: value.value, options }
        : null
    }
    default:
      return null
  }
}

/** The parameters a declaration's JSON holds, those Kettu can show, in their written order. */
export function parseParams(json: string): PageParam[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!isRecord(raw)) return []
  const out: PageParam[] = []
  for (const [name, value] of Object.entries(raw)) {
    const param = paramOf(name, value)
    if (param) out.push(param)
    if (out.length === PARAMS_MAX) break
  }
  return out
}

/** Whether `value` is one `param` takes. */
export function validParamValue(param: PageParam, value: unknown): boolean {
  switch (param.type) {
    case 'color':
      return typeof value === 'string' && COLOR.test(value)
    case 'text':
      return typeof value === 'string' && value.length <= TEXT_CHARS
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= param.min &&
        value <= param.max
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'choice':
      return typeof value === 'string' && param.options.includes(value)
  }
}

/** The CSS variable and the attribute value a parameter sets on the page's root. */
export function paramCss(
  param: Pick<PageParam, 'type'> & { unit?: string },
  value: ParamValue,
): {
  variable: string
  attribute: string
} {
  if (param.type === 'number')
    return { variable: `${value}${param.unit ?? ''}`, attribute: String(value) }
  if (param.type === 'text')
    return { variable: JSON.stringify(String(value)), attribute: String(value) }
  return { variable: String(value), attribute: String(value) }
}

/** Where the declaration's JSON lies in a page's HTML, found as the page holds it; null for none. */
export function paramsRange(html: string): { start: number; end: number } | null {
  const open = /<script\b[^>]*\bdata-kettu-params\b[^>]*>/i.exec(html)
  if (!open) return null
  const start = open.index + open[0].length
  const close = html.slice(start).search(/<\/script\s*>/i)
  return close < 0 ? null : { start, end: start + close }
}

/** The page's HTML with new values in its declaration; each one must be valid for its param. */
export function withParamValues(
  html: string,
  values: Readonly<Record<string, ParamValue>>,
): string {
  const range = paramsRange(html)
  if (!range) throw new Error('The page declares no parameters')
  const raw = JSON.parse(html.slice(range.start, range.end)) as Record<
    string,
    Record<string, unknown>
  >
  const declared = new Map(parseParams(html.slice(range.start, range.end)).map((p) => [p.name, p]))
  for (const [name, value] of Object.entries(values)) {
    const param = declared.get(name)
    if (!param || !validParamValue(param, value)) throw new Error(`${name} takes no such value`)
    raw[name] = { ...raw[name], value }
  }
  // `</` would end the script, so it never appears in the written JSON.
  const json = JSON.stringify(raw, null, 2).replace(/<\//g, '<\\/')
  return `${html.slice(0, range.start)}\n${json}\n${html.slice(range.end)}`
}
