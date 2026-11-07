// Handing pages and notes of a canvas to an agent: a message saying what to change, a data block
// with the pages and the notes on them, and each page rendered with its notes drawn over it.

import { snippet } from '@shared/artifact-runtime/page-messages'
import type { CanvasNote, CanvasPage } from '@shared/canvas-doc'
import type { UserContent } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { openNewSession } from '@renderer/stores/view'
import { block, boundary } from './anchors'
import { contains, joinedEnds, overlaps, type DocLayout } from './canvas-model'
import { noteBox } from './use-canvas-doc'

/** The widest a page's image goes into a message; a larger page is scaled down. */
const IMAGE_WIDTH = 1600

/** What the selection hands over: its pages, and the notes on them or selected with them. */
export function handOffSet(
  layout: DocLayout,
  ids: readonly string[],
): { pages: CanvasPage[]; notes: CanvasNote[] } {
  const pages = new Map<string, CanvasPage>()
  for (const id of ids) {
    const page = layout.pages.find((p) => p.id === id)
    if (page) pages.set(page.id, page)
    const section = layout.sections.find((s) => s.id === id)
    if (section) for (const p of layout.pages.filter((q) => q.section === id)) pages.set(p.id, p)
  }
  const notes = layout.notes.filter(
    (n) => ids.includes(n.id) || [...pages.values()].some((p) => overlaps(p, noteBox(n))),
  )
  // A selected note brings the page it lies on.
  for (const n of notes) {
    const box = noteBox(n)
    const under = layout.pages.find((p) =>
      contains(p, box.x + box.width / 2, box.y + box.height / 2),
    )
    if (under) pages.set(under.id, under)
  }
  return { pages: [...pages.values()], notes }
}

function noteLine(note: CanvasNote, pages: readonly CanvasPage[]): string {
  const box = noteBox(note)
  const page = pages.find((p) => overlaps(p, box))
  const at = page
    ? `on page "${snippet(page.name)}" at ${Math.round(box.x - page.x)},${Math.round(box.y - page.y)} size ${Math.round(box.width)}x${Math.round(box.height)}`
    : 'beside the pages'
  const text = note.kind === 'text' || note.kind === 'sticky' ? `: "${snippet(note.text)}"` : ''
  return `note ${note.id}, ${note.kind} in ${note.color}, ${at}${text}`
}

/** A page's image with the notes over it drawn in, base64 PNG; null when it cannot render. */
async function pageWithNotes(
  artifactId: string,
  version: number,
  page: CanvasPage,
  notes: readonly CanvasNote[],
  pages: readonly CanvasPage[],
): Promise<string | null> {
  const image = await window.kettu.artifacts.pageImage(
    artifactId,
    version,
    { group: 0, index: 1, file: page.file },
    { width: page.width, height: page.height },
  )
  if (!image) return null
  const scale = Math.min(1, IMAGE_WIDTH / page.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(page.width * scale)
  canvas.height = Math.round(page.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return image
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${image}`)).blob(),
  )
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.translate(-page.x, -page.y)
  const color = (note: CanvasNote) =>
    getComputedStyle(document.documentElement).getPropertyValue(`--note-${note.color}`).trim()
  for (const note of notes) {
    ctx.save()
    ctx.strokeStyle = color(note)
    ctx.fillStyle = color(note)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    switch (note.kind) {
      case 'pen':
        ctx.globalAlpha = note.marker ? 0.35 : 1
        ctx.lineWidth = note.width * (note.marker ? 4 : 2)
        ctx.beginPath()
        for (let i = 0; i < note.points.length; i += 3) {
          if (i === 0) ctx.moveTo(note.points[i]!, note.points[i + 1]!)
          else ctx.lineTo(note.points[i]!, note.points[i + 1]!)
        }
        ctx.stroke()
        break
      case 'sticky': {
        const box = noteBox(note)
        ctx.fillStyle = getComputedStyle(document.documentElement)
          .getPropertyValue('--sticky-paper')
          .trim()
        ctx.fillRect(box.x, box.y, box.width, box.height)
        ctx.fillStyle = getComputedStyle(document.documentElement)
          .getPropertyValue('--sticky-ink')
          .trim()
        ctx.font = '15px system-ui, sans-serif'
        wrap(ctx, note.text, box.x + 16, box.y + 28, box.width - 32, 22)
        break
      }
      case 'text':
        ctx.font = `500 ${note.size}px system-ui, sans-serif`
        ctx.fillText(note.text, note.x, note.y + note.size)
        break
      default: {
        const { x1, y1, x2, y2 } = joinedEnds(note, pages)
        ctx.lineWidth = note.width
        ctx.beginPath()
        if (note.kind === 'rect')
          ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
        else if (note.kind === 'ellipse') {
          ctx.ellipse(
            (x1 + x2) / 2,
            (y1 + y2) / 2,
            Math.abs(x2 - x1) / 2,
            Math.abs(y2 - y1) / 2,
            0,
            0,
            Math.PI * 2,
          )
        } else {
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          if (note.kind === 'arrow') {
            const angle = Math.atan2(y2 - y1, x2 - x1)
            const head = 10 + note.width * 2
            ctx.moveTo(x2, y2)
            ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45))
            ctx.moveTo(x2, y2)
            ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45))
          }
        }
        ctx.stroke()
      }
    }
    ctx.restore()
  }
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  line: number,
): void {
  let row = ''
  let at = y
  for (const char of text) {
    if (char === '\n' || ctx.measureText(row + char).width > width) {
      ctx.fillText(row, x, at)
      at += line
      row = char === '\n' ? '' : char
    } else row += char
  }
  if (row) ctx.fillText(row, x, at)
}

/**
 * Sends the selection to a session as one user message, or opens New session with its text
 * drafted when there is no session to send to.
 */
export async function handOff(input: {
  artifact: { id: string; title: string; version: number; project: string }
  layout: DocLayout
  ids: readonly string[]
  session: string | null
}): Promise<boolean> {
  const { artifact, layout } = input
  const { pages, notes } = handOffSet(layout, input.ids)
  const data = [
    `artifact: "${snippet(artifact.title)}"`,
    ...pages.map(
      (p) => `page ${p.id} "${snippet(p.name)}", file ${p.file}, ${p.width}x${p.height}`,
    ),
    ...notes.map((n) => noteLine(n, pages)),
  ]
  const mark = boundary(data)
  const text = [
    i18n.t('artifacts:board.handOffPrompt'),
    i18n.t('artifacts:prompt.selection', { id: artifact.id, version: artifact.version }),
    i18n.t('artifacts:prompt.data', { mark }),
    block(mark, data),
  ].join('\n\n')
  if (!input.session) {
    const draft = readDraft(NEW_SESSION_DRAFT)
    writeDraft(NEW_SESSION_DRAFT, draft.trim() ? `${draft}\n\n${text}` : text)
    flushDraft(NEW_SESSION_DRAFT)
    openNewSession(artifact.project, null)
    emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
    return false
  }
  const images: UserContent[] = []
  for (const page of pages.slice(0, 4)) {
    const data64 = await pageWithNotes(
      artifact.id,
      artifact.version,
      page,
      notes,
      layout.pages,
    ).catch(() => null)
    if (data64)
      images.push({ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: data64 } })
  }
  await host('sessions.queue', {
    sessionId: input.session,
    content: [{ type: 'text', text }, ...images],
  })
  return true
}
