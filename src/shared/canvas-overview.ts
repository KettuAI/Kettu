// The entry page of a canvas document where Kettu's editor is not there to draw it: published,
// exported or opened in a browser. It shows the canvases read-only, each page live in a frame of
// its own file, panned and zoomed as in the editor; a page opens alone when clicked.

import {
  joinedEnds,
  noteBox,
  NOTE_COLORS,
  sectionBox,
  type CanvasDoc,
  type CanvasNote,
} from './canvas-doc'
import { strokePath } from './canvas-stroke'

type Drawn =
  | { kind: 'text'; color: string; x: number; y: number; size: number; text: string }
  | {
      kind: 'sticky'
      x: number
      y: number
      width: number
      height: number
      text: string
      done: boolean
    }
  | { kind: 'path'; color: string; d: string; opacity: number }
  | {
      kind: 'rect' | 'ellipse' | 'line' | 'arrow'
      color: string
      width: number
      x1: number
      y1: number
      x2: number
      y2: number
    }

interface Sheet {
  name: string
  sections: { title: string; x: number; y: number; width: number; height: number }[]
  pages: { name: string; file: string; x: number; y: number; width: number; height: number }[]
  notes: Drawn[]
}

function drawn(note: CanvasNote, doc: CanvasDoc): Drawn {
  switch (note.kind) {
    case 'text':
      return {
        kind: 'text',
        color: note.color,
        x: note.x,
        y: note.y,
        size: note.size,
        text: note.text,
      }
    case 'sticky': {
      const box = noteBox(note)
      return { kind: 'sticky', ...box, text: note.text, done: note.done }
    }
    case 'pen':
      return {
        kind: 'path',
        color: note.color,
        d: strokePath(note.points, note.width, note.marker),
        opacity: note.marker ? 0.35 : 1,
      }
    default:
      return {
        kind: note.kind,
        color: note.color,
        width: note.width,
        ...joinedEnds(note, doc.pages),
      }
  }
}

function sheets(doc: CanvasDoc): Sheet[] {
  return doc.canvases.map((canvas) => {
    const pages = doc.pages.filter((p) => p.canvas === canvas.id)
    return {
      name: canvas.name,
      sections: doc.sections
        .filter((s) => s.canvas === canvas.id)
        .flatMap((s) => {
          const box = sectionBox({ pages }, s.id)
          return box ? [{ title: s.title, ...box }] : []
        }),
      pages: pages.map((p) => ({
        name: p.name,
        file: p.file,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
      })),
      notes: doc.notes.filter((n) => n.canvas === canvas.id).map((n) => drawn(n, doc)),
    }
  })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const NOTE_LIGHT: Record<(typeof NOTE_COLORS)[number], string> = {
  ink: '#1f1f1f',
  red: '#e5484d',
  orange: '#f2581b',
  yellow: '#e9a800',
  green: '#30a46c',
  blue: '#0090ff',
  violet: '#7653c9',
}
const NOTE_DARK: Record<(typeof NOTE_COLORS)[number], string> = {
  ink: '#ededed',
  red: '#ff6369',
  orange: '#ff7a3d',
  yellow: '#f5c542',
  green: '#4cc38a',
  blue: '#52a9ff',
  violet: '#a88beb',
}

const vars = (colors: Record<string, string>): string =>
  Object.entries(colors)
    .map(([name, value]) => `--note-${name}:${value};`)
    .join('')

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f5f4;--dot:rgba(0,0,0,.09);--bar:rgba(250,250,249,.86);--line:rgba(0,0,0,.08);
--text:#1c1c1c;--muted:#76767a;--hover:rgba(0,0,0,.05);--section:rgba(0,0,0,.025);--page:#fff;
--shadow:0 1px 2px rgba(0,0,0,.06),0 8px 28px -8px rgba(0,0,0,.18);--sticky:#fff0b3;--sticky-ink:#4d3b00;${vars(NOTE_LIGHT)}}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--dot:rgba(255,255,255,.08);--bar:rgba(28,28,28,.86);--line:rgba(255,255,255,.09);
--text:#ededed;--muted:#9a9a9e;--hover:rgba(255,255,255,.07);--section:rgba(255,255,255,.03);--page:#fff;
--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -8px rgba(0,0,0,.6);--sticky:#5a4812;--sticky-ink:#fdeeb5;${vars(NOTE_DARK)}}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--text);
font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
header{position:fixed;inset:0 0 auto;z-index:2;display:flex;align-items:center;gap:12px;height:48px;padding:0 12px 0 18px;
background:var(--bar);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
h1{margin:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:32vw}
nav{display:flex;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}
nav[hidden]{display:none}
button{font:inherit;color:inherit;background:none;border:0;border-radius:7px;height:28px;padding:0 10px;cursor:pointer;white-space:nowrap}
button:hover{background:var(--hover)}
button:focus-visible{outline:2px solid var(--note-blue);outline-offset:1px}
nav button{color:var(--muted)}
nav button[aria-selected=true]{color:var(--text);background:var(--hover);font-weight:500}
.zoom{margin-left:auto;display:flex;align-items:center;gap:2px;color:var(--muted)}
.zoom output{min-width:46px;text-align:center;font-variant-numeric:tabular-nums}
#stage{position:fixed;inset:48px 0 0;overflow:hidden;cursor:grab;touch-action:none;
background-image:radial-gradient(var(--dot) 1px,transparent 1px);background-size:24px 24px}
#stage.panning{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.section{position:absolute;border-radius:24px;background:var(--section);border:1px solid var(--line)}
.section span{position:absolute;left:calc(4px / var(--z));bottom:100%;padding-bottom:calc(8px / var(--z));font-weight:600;font-size:calc(13px / var(--z));color:var(--text);white-space:nowrap}
.page{position:absolute;display:block;color:inherit;text-decoration:none}
.page>span{position:absolute;left:0;bottom:100%;padding-bottom:calc(6px / var(--z));font-size:calc(12px / var(--z));color:var(--muted);
white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.page:hover>span{color:var(--text)}
.page>div{width:100%;height:100%;background:var(--page);box-shadow:var(--shadow);border-radius:calc(4px / var(--z));overflow:hidden}
.page:hover>div{outline:calc(2px / var(--z)) solid var(--note-blue)}
.page iframe{border:0;display:block;pointer-events:none}
svg.notes{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.text{position:absolute;font-weight:500;line-height:1.3;white-space:pre;pointer-events:none}
.sticky{position:absolute;padding:14px 16px 12px;border-radius:3px;background:var(--sticky);color:var(--sticky-ink);
font-size:15px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 1px var(--line),0 10px 22px -10px rgba(0,0,0,.3);pointer-events:none}
.sticky.done{opacity:.55}
.empty{position:fixed;inset:48px 0 0;display:grid;place-items:center;color:var(--muted)}
`

const SCRIPT = `
(() => {
  const data = JSON.parse(document.getElementById('kettu-canvas').textContent)
  const stage = document.getElementById('stage')
  const world = document.getElementById('world')
  const nav = document.querySelector('nav')
  const level = document.querySelector('output')
  const SVG = 'http://www.w3.org/2000/svg'
  let cam = { x: 0, y: 0, z: 1 }
  let bounds = null
  const apply = () => {
    world.style.transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.z + ')'
    world.style.setProperty('--z', String(cam.z))
    level.textContent = Math.round(cam.z * 100) + '%'
  }
  const zoomAt = (z, px, py) => {
    z = Math.min(4, Math.max(0.02, z))
    cam = { z, x: px - ((px - cam.x) * z) / cam.z, y: py - ((py - cam.y) * z) / cam.z }
    apply()
  }
  const fit = () => {
    if (!bounds) return
    const w = stage.clientWidth, h = stage.clientHeight, pad = 72
    const z = Math.min(1, (w - 2 * pad) / bounds.w, (h - 2 * pad) / bounds.h)
    cam = { z, x: (w - bounds.w * z) / 2 - bounds.x * z, y: (h - bounds.h * z) / 2 - bounds.y * z }
    apply()
  }
  const el = (tag, cls, parent) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    parent.appendChild(node)
    return node
  }
  const show = (index) => {
    const sheet = data.canvases[index]
    for (const tab of nav.children) tab.setAttribute('aria-selected', String(tab.dataset.i === String(index)))
    world.replaceChildren()
    const boxes = []
    for (const s of sheet.sections) {
      const node = el('div', 'section', world)
      Object.assign(node.style, { left: s.x + 'px', top: s.y + 'px', width: s.width + 'px', height: s.height + 'px' })
      el('span', '', node).textContent = s.title
      boxes.push(s)
    }
    for (const p of sheet.pages) {
      const link = el('a', 'page', world)
      link.href = encodeURI(p.file)
      Object.assign(link.style, { left: p.x + 'px', top: p.y + 'px', width: p.width + 'px', height: p.height + 'px' })
      el('span', '', link).textContent = p.name
      const frame = el('iframe', '', el('div', '', link))
      frame.src = encodeURI(p.file)
      frame.title = p.name
      frame.loading = 'lazy'
      frame.tabIndex = -1
      frame.width = String(p.width)
      frame.height = String(p.height)
      boxes.push(p)
    }
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('class', 'notes')
    svg.setAttribute('width', '1')
    svg.setAttribute('height', '1')
    world.appendChild(svg)
    const shape = (name, attrs) => {
      const node = document.createElementNS(SVG, name)
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
      svg.appendChild(node)
      return node
    }
    sheet.notes.forEach((n, i) => {
      const color = n.color ? 'var(--note-' + n.color + ')' : ''
      if (n.kind === 'text') {
        const node = el('div', 'text', world)
        Object.assign(node.style, { left: n.x + 'px', top: n.y + 'px', fontSize: n.size + 'px', color })
        node.textContent = n.text
      } else if (n.kind === 'sticky') {
        const node = el('div', n.done ? 'sticky done' : 'sticky', world)
        Object.assign(node.style, { left: n.x + 'px', top: n.y + 'px', width: n.width + 'px', minHeight: n.height + 'px' })
        node.textContent = n.text
        boxes.push(n)
      } else if (n.kind === 'path') {
        if (n.d) shape('path', { d: n.d, fill: color, opacity: n.opacity })
      } else {
        const stroke = { fill: 'none', stroke: color, 'stroke-width': n.width, 'stroke-linecap': 'round' }
        const x = Math.min(n.x1, n.x2), y = Math.min(n.y1, n.y2)
        const w = Math.abs(n.x2 - n.x1), h = Math.abs(n.y2 - n.y1)
        if (n.kind === 'rect') shape('rect', { ...stroke, x, y, width: w, height: h, rx: 6 })
        else if (n.kind === 'ellipse') shape('ellipse', { ...stroke, cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 })
        else {
          const line = shape('line', { ...stroke, x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 })
          if (n.kind === 'arrow') {
            const id = 'head' + i
            const marker = shape('marker', { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' })
            const tip = document.createElementNS(SVG, 'path')
            tip.setAttribute('d', 'M0 0L10 5 0 10z')
            tip.setAttribute('fill', color)
            marker.appendChild(tip)
            line.setAttribute('marker-end', 'url(#' + id + ')')
          }
        }
      }
    })
    document.querySelector('.empty')?.remove()
    if (boxes.length === 0) {
      bounds = null
      el('div', 'empty', document.body).textContent = data.empty
      return
    }
    const left = Math.min(...boxes.map((b) => b.x)), top = Math.min(...boxes.map((b) => b.y))
    const right = Math.max(...boxes.map((b) => b.x + b.width)), bottom = Math.max(...boxes.map((b) => b.y + (b.height || 0)))
    bounds = { x: left, y: top, w: right - left, h: bottom - top }
    fit()
  }
  data.canvases.forEach((sheet, i) => {
    const tab = el('button', '', nav)
    tab.type = 'button'
    tab.setAttribute('role', 'tab')
    tab.dataset.i = String(i)
    tab.textContent = sheet.name
    tab.onclick = () => show(i)
  })
  if (data.canvases.length < 2) nav.hidden = true
  document.getElementById('out').onclick = () => zoomAt(cam.z / 1.25, stage.clientWidth / 2, stage.clientHeight / 2)
  document.getElementById('in').onclick = () => zoomAt(cam.z * 1.25, stage.clientWidth / 2, stage.clientHeight / 2)
  document.getElementById('fit').onclick = fit
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = stage.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) zoomAt(cam.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
    else {
      cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY }
      apply()
    }
  }, { passive: false })
  let drag = null
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }
  })
  stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    if (!drag.moved) {
      drag.moved = true
      stage.setPointerCapture(e.pointerId)
      stage.classList.add('panning')
    }
    cam = { ...cam, x: drag.cx + dx, y: drag.cy + dy }
    apply()
  })
  const end = () => {
    stage.classList.remove('panning')
    setTimeout(() => (drag = null))
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('click', (e) => {
    if (drag && drag.moved) e.preventDefault()
  }, true)
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return
    if (e.key === '+' || e.key === '=') zoomAt(cam.z * 1.25, stage.clientWidth / 2, stage.clientHeight / 2)
    else if (e.key === '-') zoomAt(cam.z / 1.25, stage.clientWidth / 2, stage.clientHeight / 2)
    else if (e.key === '0') fit()
  })
  window.addEventListener('resize', fit)
  show(0)
})()
`

/**
 * The overview page of a canvas document, in the reader's language for its few words. The pages
 * load from their files beside it, so it goes at the root of the artifact's files.
 */
export function canvasOverview(
  doc: CanvasDoc,
  title: string,
  words: { zoomIn: string; zoomOut: string; fit: string; empty: string; lang: string },
): string {
  // `<` is escaped so no text in the data can close its script element.
  const data = JSON.stringify({ canvases: sheets(doc), empty: words.empty }).replace(
    /</g,
    '\\u003c',
  )
  return (
    `<!doctype html><html lang="${escapeHtml(words.lang)}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>` +
    `<header><h1>${escapeHtml(title)}</h1><nav role="tablist"></nav><div class="zoom">` +
    `<button type="button" id="out" aria-label="${escapeHtml(words.zoomOut)}">&minus;</button>` +
    '<output></output>' +
    `<button type="button" id="in" aria-label="${escapeHtml(words.zoomIn)}">+</button>` +
    `<button type="button" id="fit">${escapeHtml(words.fit)}</button></div></header>` +
    '<main id="stage"><div id="world"></div></main>' +
    `<script type="application/json" id="kettu-canvas">${data}</script>` +
    `<script>${SCRIPT}</script></body></html>`
  )
}
