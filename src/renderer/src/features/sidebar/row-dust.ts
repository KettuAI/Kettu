import { isWeb } from '@renderer/lib/platform'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { markDust, unmarkDust } from './row-exit'

/** More rows than this leave quietly: a sidebar of dust says less than a few rows of it. */
const MOST_ROWS = 6
const STAGGER_MS = 40
/** The sweep frees a row's pixels from left to right; each then drifts for about its life. */
const SWEEP_MS = 320
const JITTER_MS = 110
const LIFE_MS = 620
/** How far above and below its rows the dust may drift, in CSS pixels. */
const ROOM_ABOVE = 64
const ROOM_BELOW = 14
/** How long to wait for the menus and dialogs over the window to close before reading it. */
const SETTLE_MS = 600
const COVERS = '[role="menu"], [role="alertdialog"], [data-slot="alert-dialog-overlay"]'

export interface Dust {
  /** Brings back the rows of sessions that were not deleted after all. */
  restore(ids: readonly string[]): void
}

const NO_DUST: Dust = { restore: () => {} }

interface Row {
  id: string
  li: HTMLElement
  box: DOMRect
}

/**
 * Turns the sidebar rows of these sessions to dust, from the window's own pixels, before they are
 * deleted. Resolves once the dust has started, or at once when the rows will leave quietly
 * instead: reduced motion, the web client, too many rows, or a window that could not be read.
 */
export async function dissolveRows(ids: readonly string[]): Promise<Dust> {
  if (isWeb || ids.length === 0 || prefersReducedMotion()) return NO_DUST
  const before = rowsOf(ids)
  if (before.length === 0 || before.length > MOST_ROWS) return NO_DUST
  if (!(await settled(union(before.map((row) => row.box))))) return NO_DUST
  const rows = rowsOf(ids)
  if (rows.length === 0 || rows.length > MOST_ROWS) return NO_DUST
  const clip = clipBox(rows[0].li)
  const area = union(rows.map((row) => row.box))
  let bytes: Uint8Array | null = null
  try {
    // A DOMRect does not cross IPC as one.
    const { x, y, width, height } = area
    bytes = await window.kettu.app.captureRect({ x, y, width, height })
  } catch (error) {
    console.warn(`Could not read the sidebar for its dust: ${(error as Error).message}`)
  }
  if (!bytes || rows.some((row) => !row.li.isConnected)) return NO_DUST
  const pixels = await decode(bytes)
  if (!pixels) return NO_DUST

  const dpr = window.devicePixelRatio || 1
  const view = {
    left: clip.left,
    top: Math.max(clip.top, area.y - ROOM_ABOVE),
    right: clip.right,
    bottom: Math.min(clip.bottom, area.y + area.height + ROOM_BELOW),
  }
  const dust = particles(rows, area, pixels)
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.width = Math.round((view.right - view.left) * dpr)
  canvas.height = Math.round((view.bottom - view.top) * dpr)
  Object.assign(canvas.style, {
    position: 'fixed',
    left: `${view.left}px`,
    top: `${view.top}px`,
    width: `${view.right - view.left}px`,
    height: `${view.bottom - view.top}px`,
    pointerEvents: 'none',
    zIndex: '40',
  })
  document.body.append(canvas)

  const alive = rows.map(() => true)
  for (const [i, row] of rows.entries()) {
    row.li.dataset.rowExit = 'dust'
    markDust([row.id], i * STAGGER_MS + SWEEP_MS + JITTER_MS)
  }
  drift(canvas, view, dpr, dust, alive)
  return {
    restore: (back) => {
      for (const [i, row] of rows.entries()) {
        if (!back.includes(row.id)) continue
        alive[i] = false
        delete row.li.dataset.rowExit
        unmarkDust([row.id])
      }
    },
  }
}

/**
 * Waits for the menus and dialogs over the rows to close and for a frame without them to reach the
 * screen, since the rows are read from it.
 */
async function settled(area: DOMRect): Promise<boolean> {
  const start = performance.now()
  while (covered(area)) {
    if (performance.now() - start > SETTLE_MS) return false
    await frame()
  }
  await frame()
  await frame()
  return !document.hidden
}

/** Whether a menu or a dialog's backdrop lies over the area; some menus stay mounted hidden. */
function covered(area: DOMRect): boolean {
  return [...document.querySelectorAll<HTMLElement>(COVERS)].some((cover) => {
    if (!cover.checkVisibility()) return false
    const rect = cover.getBoundingClientRect()
    return (
      rect.left < area.right &&
      rect.right > area.left &&
      rect.top < area.bottom &&
      rect.bottom > area.top
    )
  })
}

/** The next frame; a hidden window draws none, so a timer stands in for it there. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
    setTimeout(resolve, 50)
  })
}

/** Each session's rows in sight in the sidebar, outermost only: a sub-session's goes with it. */
function rowsOf(ids: readonly string[]): Row[] {
  const lis = ids.flatMap((id) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        `aside [data-sidebar-row][data-session-id="${CSS.escape(id)}"]`,
      ),
    ].flatMap((button) => {
      const li = button.closest('li')
      return li ? [{ id, li }] : []
    }),
  )
  return lis.flatMap(({ id, li }) => {
    if (lis.some((other) => other.li !== li && other.li.contains(li))) return []
    const clip = clipBox(li)
    const rect = li.getBoundingClientRect()
    const left = Math.max(rect.left, clip.left)
    const top = Math.max(rect.top, clip.top)
    const right = Math.min(rect.right, clip.right)
    const bottom = Math.min(rect.bottom, clip.bottom)
    if (right - left < 1 || bottom - top < 1) return []
    return [{ id, li, box: new DOMRect(left, top, right - left, bottom - top) }]
  })
}

/** Where the sidebar shows what is inside it: its own box cut by the boxes that scroll. */
function clipBox(el: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const aside = el.closest('aside')
  const outer = (aside ?? document.documentElement).getBoundingClientRect()
  let box = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom }
  for (let node = el.parentElement; node && node !== aside; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const rect = node.getBoundingClientRect()
    box = {
      left: Math.max(box.left, rect.left),
      top: Math.max(box.top, rect.top),
      right: Math.min(box.right, rect.right),
      bottom: Math.min(box.bottom, rect.bottom),
    }
  }
  return box
}

/** The boxes' bounds on whole CSS pixels, which is what main reads. */
function union(boxes: readonly DOMRect[]): DOMRect {
  const left = Math.floor(Math.min(...boxes.map((b) => b.left)))
  const top = Math.floor(Math.min(...boxes.map((b) => b.top)))
  const right = Math.ceil(Math.max(...boxes.map((b) => b.right)))
  const bottom = Math.ceil(Math.max(...boxes.map((b) => b.bottom)))
  return new DOMRect(left, top, right - left, bottom - top)
}

async function decode(bytes: Uint8Array): Promise<ImageData | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return context.getImageData(0, 0, canvas.width, canvas.height)
  } catch (error) {
    console.warn(`Could not read the sidebar for its dust: ${(error as Error).message}`)
    return null
  }
}

/** Every particle's start, motion and color, one per pixel of the rows that is not background. */
interface Particles {
  count: number
  row: Uint8Array
  /** Start in CSS pixels of the page. */
  x: Float32Array
  y: Float32Array
  /** Speed in CSS pixels a second, and the upward pull. */
  vx: Float32Array
  vy: Float32Array
  lift: Float32Array
  phase: Float32Array
  delay: Float32Array
  life: Float32Array
  /** Little-endian RGBA as ImageData lays it out, alpha included. */
  color: Uint32Array
  big: Uint8Array
}

function particles(rows: readonly Row[], area: DOMRect, image: ImageData): Particles {
  const scale = image.width / area.width
  const { data, width } = image
  const found: number[] = []
  const meta: { row: number; fx: number; fy: number; x: number; y: number; color: number }[] = []
  for (const [r, row] of rows.entries()) {
    const x0 = Math.max(0, Math.round((row.box.left - area.x) * scale))
    const y0 = Math.max(0, Math.round((row.box.top - area.y) * scale))
    const x1 = Math.min(image.width, Math.round((row.box.right - area.x) * scale))
    const y1 = Math.min(image.height, Math.round((row.box.bottom - area.y) * scale))
    // The row's top left corner lies outside its rounded fill, on the sidebar's own background.
    const bg = (y0 * width + x0) * 4
    const back = [data[bg], data[bg + 1], data[bg + 2], data[bg + 3]] as const
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = (y * width + x) * 4
        const color = unblend(data[k], data[k + 1], data[k + 2], data[k + 3], back)
        if (color === null) continue
        found.push(k)
        meta.push({
          row: r,
          fx: (x - x0) / Math.max(1, x1 - x0),
          fy: (y - y0) / Math.max(1, y1 - y0),
          x: area.x + (x + 0.5) / scale,
          y: area.y + (y + 0.5) / scale,
          color,
        })
      }
    }
  }
  const count = meta.length
  const out: Particles = {
    count,
    row: new Uint8Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    lift: new Float32Array(count),
    phase: new Float32Array(count),
    delay: new Float32Array(count),
    life: new Float32Array(count),
    color: new Uint32Array(count),
    big: new Uint8Array(count),
  }
  for (let i = 0; i < count; i++) {
    const p = meta[i]
    out.row[i] = p.row
    out.x[i] = p.x
    out.y[i] = p.y
    out.vx[i] = 22 + Math.random() * 78
    out.vy[i] = -(8 + Math.random() * 40)
    out.lift[i] = -(20 + Math.random() * 70)
    out.phase[i] = Math.random() * Math.PI * 2
    out.delay[i] =
      p.row * STAGGER_MS + (p.fx * 0.88 + (1 - p.fy) * 0.12) * SWEEP_MS + Math.random() * JITTER_MS
    out.life[i] = LIFE_MS * (0.7 + Math.random() * 0.5)
    out.color[i] = p.color
    out.big[i] = Math.random() < 0.35 ? 1 : 0
  }
  return out
}

/**
 * The row's own color and opacity over the sidebar's background, so that drawn over that
 * background again it looks as it did: the least opacity that explains the pixel, as GIMP's
 * color to alpha, worked on premultiplied values. Null for background.
 */
function unblend(
  r: number,
  g: number,
  b: number,
  a: number,
  back: readonly [number, number, number, number],
): number | null {
  const pa = a / 255
  const ba = back[3] / 255
  const pixel = [(r / 255) * pa, (g / 255) * pa, (b / 255) * pa]
  const under = [(back[0] / 255) * ba, (back[1] / 255) * ba, (back[2] / 255) * ba]
  let alpha = ba < 1 ? (pa - ba) / (1 - ba) : 0
  for (let c = 0; c < 3; c++) {
    if (under[c] > 0) alpha = Math.max(alpha, 1 - pixel[c] / under[c])
    if (under[c] < 1) alpha = Math.max(alpha, (pixel[c] - under[c]) / (1 - under[c]))
  }
  alpha = Math.min(1, alpha)
  if (alpha < 0.02) return null
  const channel = (c: number) =>
    Math.round(Math.min(1, Math.max(0, (pixel[c] - (1 - alpha) * under[c]) / alpha)) * 255)
  return (
    ((Math.round(alpha * 255) << 24) | (channel(2) << 16) | (channel(1) << 8) | channel(0)) >>> 0
  )
}

/** Draws the dust frame by frame into the canvas, then takes the canvas away. */
function drift(
  canvas: HTMLCanvasElement,
  view: { left: number; top: number },
  dpr: number,
  dust: Particles,
  alive: readonly boolean[],
): void {
  const context = canvas.getContext('2d')
  if (!context) {
    canvas.remove()
    return
  }
  const out = context.createImageData(canvas.width, canvas.height)
  const pixels = new Uint32Array(out.data.buffer)
  const { width, height } = canvas
  const put = (x: number, y: number, color: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = color
  }
  const end = (alive.length - 1) * STAGGER_MS + SWEEP_MS + JITTER_MS + LIFE_MS * 1.2
  const start = performance.now()
  const draw = (now: number) => {
    const t = now - start
    pixels.fill(0)
    for (let i = 0; i < dust.count; i++) {
      if (!alive[dust.row[i]]) continue
      const lived = t - dust.delay[i]
      const color = dust.color[i]
      if (lived <= 0) {
        put(
          Math.round((dust.x[i] - view.left) * dpr),
          Math.round((dust.y[i] - view.top) * dpr),
          color,
        )
        continue
      }
      const k = lived / dust.life[i]
      if (k >= 1) continue
      const s = lived / 1000
      const x = Math.round(
        (dust.x[i] + dust.vx[i] * s + Math.sin(dust.phase[i] + s * 9) * 3 * k - view.left) * dpr,
      )
      const y = Math.round((dust.y[i] + dust.vy[i] * s + dust.lift[i] * s * s - view.top) * dpr)
      const alpha = Math.round((color >>> 24) * Math.pow(1 - k, 1.8))
      const faded = ((alpha << 24) | (color & 0xffffff)) >>> 0
      put(x, y, faded)
      if (dust.big[i] && dpr >= 2) {
        put(x + 1, y, faded)
        put(x, y + 1, faded)
        put(x + 1, y + 1, faded)
      }
    }
    context.putImageData(out, 0, 0)
    if (t < end && canvas.isConnected && alive.includes(true)) requestAnimationFrame(draw)
    else canvas.remove()
  }
  // Drawn now, in the task that hides the rows, so they never blink.
  draw(start)
}
