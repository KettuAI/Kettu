import { isWeb } from '@renderer/lib/platform'
import { prefersReducedMotion } from '@renderer/stores/settings'

const STAGGER_MS = 40
/** The sweep frees a piece's pixels from left to right; each then drifts for about its life. */
const SWEEP_MS = 320
const JITTER_MS = 110
const LIFE_MS = 620
/** How far around its pieces the dust may drift, in CSS pixels. */
const ROOM_ABOVE = 64
const ROOM_BELOW = 14
const ROOM_LEFT = 4
const ROOM_RIGHT = 80
/** How long to wait for the menus and dialogs over the window to close before reading it. */
const SETTLE_MS = 600
const COVERS = '[role="menu"], [role="alertdialog"], [data-slot="alert-dialog-overlay"]'

/** An element to turn to dust, with the part of it in sight in CSS pixels of the page. */
export interface Piece {
  el: HTMLElement
  box: DOMRect
}

export interface DustOptions<P extends Piece> {
  /** The pieces in sight; asked again once the window has settled, since they may have moved. */
  find(): P[]
  /** More pieces than this leave without dust: a screen of dust says less than a little of it. */
  most: number
  /** The element whose box bounds the dust, by selector; the window when there is none. */
  within?: string
  /** Device pixels a particle stands for along each side: 2 reads one pixel in four. */
  step?: number
  /** Hides a piece in the task that draws its dust first, so it never blinks. */
  hide(piece: P, sweepMs: number): void
  /** What is read, for the log: "the sidebar". */
  what: string
}

export interface Dust<P extends Piece> {
  pieces: P[]
  /** How long after the dust started the sweep has passed piece `i`, in milliseconds. */
  passed(i: number): number
  /** Stops drawing piece `i`'s dust, for a piece that comes back. */
  stop(i: number): void
}

/**
 * Turns these pieces to dust, from the window's own pixels. Resolves once the dust has started,
 * or with null when they should leave without it: reduced motion, the web client, too many
 * pieces, or a window that could not be read.
 */
export async function dissolve<P extends Piece>(options: DustOptions<P>): Promise<Dust<P> | null> {
  const { find, most, within, step = 1, hide, what } = options
  if (isWeb || prefersReducedMotion()) return null
  const before = find()
  if (before.length === 0 || before.length > most) return null
  if (!(await settled(union(before.map((piece) => piece.box))))) return null
  const pieces = find()
  if (pieces.length === 0 || pieces.length > most) return null
  const clip = clipBox(pieces[0].el, within)
  const area = union(pieces.map((piece) => piece.box))
  let bytes: Uint8Array | null = null
  try {
    // A DOMRect does not cross IPC as one.
    const { x, y, width, height } = area
    bytes = await window.kettu.app.captureRect({ x, y, width, height })
  } catch (error) {
    console.warn(`Could not read ${what} for its dust: ${(error as Error).message}`)
  }
  if (!bytes || pieces.some((piece) => !piece.el.isConnected)) return null
  const pixels = await decode(bytes, what)
  if (!pixels) return null

  const dpr = window.devicePixelRatio || 1
  const view = {
    left: Math.max(clip.left, area.left - ROOM_LEFT),
    top: Math.max(clip.top, area.top - ROOM_ABOVE),
    right: Math.min(clip.right, area.right + ROOM_RIGHT),
    bottom: Math.min(clip.bottom, area.bottom + ROOM_BELOW),
  }
  const dust = particles(pieces, area, pixels, step)
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

  const passed = (i: number): number => i * STAGGER_MS + SWEEP_MS + JITTER_MS
  const alive = pieces.map(() => true)
  for (const [i, piece] of pieces.entries()) hide(piece, passed(i))
  drift(canvas, view, dpr, step, dust, alive)
  return {
    pieces,
    passed,
    stop: (i) => {
      alive[i] = false
    },
  }
}

/** The part of the element in sight: its box cut by the boxes that scroll. Null when none is. */
export function inSight(el: HTMLElement, within?: string): DOMRect | null {
  const clip = clipBox(el, within)
  const rect = el.getBoundingClientRect()
  const left = Math.max(rect.left, clip.left)
  const top = Math.max(rect.top, clip.top)
  const right = Math.min(rect.right, clip.right)
  const bottom = Math.min(rect.bottom, clip.bottom)
  if (right - left < 1 || bottom - top < 1) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Waits for the menus and dialogs over the pieces to close and for a frame without them to reach
 * the screen, since the pieces are read from it.
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

/** Where `within` shows what is inside it: its own box cut by the boxes that scroll. */
function clipBox(
  el: HTMLElement,
  within: string | undefined,
): { left: number; top: number; right: number; bottom: number } {
  const root = within ? el.closest(within) : null
  const outer = (root ?? document.documentElement).getBoundingClientRect()
  let box = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom }
  for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
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

async function decode(bytes: Uint8Array, what: string): Promise<ImageData | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return context.getImageData(0, 0, canvas.width, canvas.height)
  } catch (error) {
    console.warn(`Could not read ${what} for its dust: ${(error as Error).message}`)
    return null
  }
}

/** Every particle's start, motion and color, one per `step` of the pieces that is not background. */
interface Particles {
  count: number
  piece: Uint8Array
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

function particles(
  pieces: readonly Piece[],
  area: DOMRect,
  image: ImageData,
  step: number,
): Particles {
  const scale = image.width / area.width
  const { data, width } = image
  // The pixel at the middle of each step, so a particle sits where the pixels it stands for were.
  const mid = Math.floor(step / 2)
  const meta: { piece: number; fx: number; fy: number; x: number; y: number; color: number }[] = []
  for (const [p, piece] of pieces.entries()) {
    const x0 = Math.max(0, Math.round((piece.box.left - area.x) * scale))
    const y0 = Math.max(0, Math.round((piece.box.top - area.y) * scale))
    const x1 = Math.min(image.width, Math.round((piece.box.right - area.x) * scale))
    const y1 = Math.min(image.height, Math.round((piece.box.bottom - area.y) * scale))
    // The piece's top left corner lies outside its rounded fill, on the background behind it.
    const bg = (y0 * width + x0) * 4
    const back = [data[bg], data[bg + 1], data[bg + 2], data[bg + 3]] as const
    for (let y = y0; y + mid < y1; y += step) {
      for (let x = x0; x + mid < x1; x += step) {
        const k = ((y + mid) * width + x + mid) * 4
        const color = unblend(data[k], data[k + 1], data[k + 2], data[k + 3], back)
        if (color === null) continue
        meta.push({
          piece: p,
          fx: (x - x0) / Math.max(1, x1 - x0),
          fy: (y - y0) / Math.max(1, y1 - y0),
          x: area.x + (x + mid + 0.5) / scale,
          y: area.y + (y + mid + 0.5) / scale,
          color,
        })
      }
    }
  }
  const count = meta.length
  const out: Particles = {
    count,
    piece: new Uint8Array(count),
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
    out.piece[i] = p.piece
    out.x[i] = p.x
    out.y[i] = p.y
    out.vx[i] = 22 + Math.random() * 78
    out.vy[i] = -(8 + Math.random() * 40)
    out.lift[i] = -(20 + Math.random() * 70)
    out.phase[i] = Math.random() * Math.PI * 2
    out.delay[i] =
      p.piece * STAGGER_MS +
      (p.fx * 0.88 + (1 - p.fy) * 0.12) * SWEEP_MS +
      Math.random() * JITTER_MS
    out.life[i] = LIFE_MS * (0.7 + Math.random() * 0.5)
    out.color[i] = p.color
    out.big[i] = Math.random() < 0.35 ? 1 : 0
  }
  return out
}

/**
 * The piece's own color and opacity over its background, so that drawn over that background
 * again it looks as it did: the least opacity that explains the pixel, as GIMP's color to alpha,
 * worked on premultiplied values. Null for background.
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
  step: number,
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
  // A particle covers the step it stands for, centered on its point; a big one a pixel more.
  const mid = Math.floor(step / 2)
  const put = (x: number, y: number, size: number, color: number) => {
    for (let py = y - mid; py < y - mid + size; py++) {
      if (py < 0 || py >= height) continue
      for (let px = x - mid; px < x - mid + size; px++) {
        if (px >= 0 && px < width) pixels[py * width + px] = color
      }
    }
  }
  const end = (alive.length - 1) * STAGGER_MS + SWEEP_MS + JITTER_MS + LIFE_MS * 1.2
  const start = performance.now()
  const draw = (now: number) => {
    const t = now - start
    pixels.fill(0)
    for (let i = 0; i < dust.count; i++) {
      if (!alive[dust.piece[i]]) continue
      const lived = t - dust.delay[i]
      const color = dust.color[i]
      if (lived <= 0) {
        put(
          Math.round((dust.x[i] - view.left) * dpr),
          Math.round((dust.y[i] - view.top) * dpr),
          step,
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
      put(x, y, dust.big[i] && dpr >= 2 ? step + 1 : step, faded)
    }
    context.putImageData(out, 0, 0)
    if (t < end && canvas.isConnected && alive.includes(true)) requestAnimationFrame(draw)
    else canvas.remove()
  }
  // Drawn now, in the task that hides the pieces, so they never blink.
  draw(start)
}
