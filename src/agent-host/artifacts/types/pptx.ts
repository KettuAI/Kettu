// A slides artifact as a PowerPoint file: each layout placed on the slide in the deck's colors,
// with the presenter's notes. Loaded with the first export.

import PptxGenJS from 'pptxgenjs'
import {
  bulletParts,
  DECK_PALETTES,
  type Bullet,
  type Column,
  type Deck,
  type Slide,
} from '@shared/artifact-slides'
import { imageInfo } from './images'

/** The slide's width in inches; its height follows the deck's aspect. */
const WIDTH = 10
const MARGIN = 0.6
const FONT = 'Arial'
const BODY = 18
const TITLE_TOP = 0.4
const TITLE_HEIGHT = 0.9
const BODY_TOP = 1.45

type PptxSlide = ReturnType<PptxGenJS['addSlide']>
type Palette = (typeof DECK_PALETTES)['light']
type Box = { x: number; y: number; w: number; h: number }

const hex = (color: string): string => color.replace('#', '').toUpperCase()

function bulletRuns(bullets: readonly Bullet[], palette: Palette): PptxGenJS.TextProps[] {
  return bullets.flatMap((bullet) => {
    const { text, bullets: under } = bulletParts(bullet)
    return [
      { text, options: { bullet: true, breakLine: true, color: hex(palette.text) } },
      ...under.map((point) => ({
        text: point,
        options: {
          bullet: true,
          indentLevel: 1,
          breakLine: true,
          fontSize: BODY - 2,
          color: hex(palette.muted),
        },
      })),
    ]
  })
}

class Builder {
  readonly height: number

  constructor(
    private readonly pptx: PptxGenJS,
    private readonly palette: Palette,
    private readonly images: ReadonlyMap<string, Uint8Array>,
    aspect: Deck['aspect'],
  ) {
    this.height = aspect === '4:3' ? 7.5 : 5.625
  }

  private title(slide: PptxSlide, text: string | undefined): void {
    if (!text) return
    slide.addText(text, {
      x: MARGIN,
      y: TITLE_TOP,
      w: WIDTH - 2 * MARGIN,
      h: TITLE_HEIGHT,
      fontFace: FONT,
      fontSize: 28,
      bold: true,
      color: hex(this.palette.text),
      valign: 'middle',
      fit: 'shrink',
    })
  }

  private accent(slide: PptxSlide, x: number, y: number, w = 0.8): void {
    slide.addShape(this.pptx.ShapeType.rect, {
      x,
      y,
      w,
      h: 0.06,
      fill: { color: hex(this.palette.accent) },
      line: { color: hex(this.palette.accent), width: 0 },
    })
  }

  /** The picture fitted inside the box and centred, or its alt text when it cannot be read. */
  private picture(slide: PptxSlide, path: string, alt: string, box: Box): void {
    const bytes = this.images.get(path)
    const info = bytes ? imageInfo(bytes) : null
    if (!bytes || !info || info.width === 0 || info.height === 0) {
      slide.addText(alt, {
        ...box,
        fontFace: FONT,
        fontSize: 14,
        color: hex(this.palette.muted),
        align: 'center',
      })
      return
    }
    const scale = Math.min(box.w / info.width, box.h / info.height)
    const w = info.width * scale
    const h = info.height * scale
    slide.addImage({
      data: `image/${info.type};base64,${Buffer.from(bytes).toString('base64')}`,
      x: box.x + (box.w - w) / 2,
      y: box.y + (box.h - h) / 2,
      w,
      h,
      altText: alt,
    })
  }

  private column(slide: PptxSlide, column: Column, box: Box): void {
    const runs: PptxGenJS.TextProps[] = []
    if (column.heading) {
      runs.push({
        text: column.heading,
        options: { bold: true, fontSize: 20, breakLine: true, color: hex(this.palette.text) },
      })
    }
    if (column.text) {
      runs.push({ text: column.text, options: { breakLine: true, color: hex(this.palette.text) } })
    }
    if (column.bullets) runs.push(...bulletRuns(column.bullets, this.palette))
    slide.addText(runs, {
      ...box,
      fontFace: FONT,
      fontSize: BODY,
      valign: 'top',
      paraSpaceAfter: 6,
    })
  }

  add(source: Slide): void {
    const { palette, height } = this
    const slide = this.pptx.addSlide()
    slide.background = { color: hex(palette.background) }
    const inner = WIDTH - 2 * MARGIN
    const body: Box = { x: MARGIN, y: BODY_TOP, w: inner, h: height - BODY_TOP - 0.5 }
    switch (source.layout) {
      case 'title':
      case 'section': {
        const cover = source.layout === 'title'
        const top = height * (cover ? 0.34 : 0.4)
        this.accent(slide, MARGIN, top - 0.2)
        slide.addText(source.title, {
          x: MARGIN,
          y: top,
          w: inner,
          h: 1.2,
          fontFace: FONT,
          fontSize: cover ? 40 : 34,
          bold: true,
          color: hex(palette.text),
          valign: 'top',
          fit: 'shrink',
        })
        if (source.subtitle) {
          slide.addText(source.subtitle, {
            x: MARGIN,
            y: top + 1.25,
            w: inner,
            h: 0.9,
            fontFace: FONT,
            fontSize: 20,
            color: hex(palette.muted),
            valign: 'top',
          })
        }
        break
      }
      case 'bullets': {
        this.title(slide, source.title)
        const half = source.image ? inner / 2 - 0.15 : inner
        slide.addText(bulletRuns(source.bullets, palette), {
          ...body,
          w: half,
          fontFace: FONT,
          fontSize: BODY,
          valign: 'top',
          paraSpaceAfter: 8,
          fit: 'shrink',
        })
        if (source.image) {
          this.picture(slide, source.image, source.alt ?? '', {
            ...body,
            x: MARGIN + half + 0.3,
            w: half,
          })
        }
        break
      }
      case 'two-column': {
        this.title(slide, source.title)
        const top = source.title ? body : { ...body, y: TITLE_TOP, h: height - TITLE_TOP - 0.5 }
        const half = inner / 2 - 0.2
        this.column(slide, source.left, { ...top, w: half })
        this.column(slide, source.right, { ...top, x: MARGIN + half + 0.4, w: half })
        break
      }
      case 'image': {
        this.title(slide, source.title)
        const top = source.title ? BODY_TOP : TITLE_TOP
        const bottom = source.caption ? 0.9 : 0.4
        this.picture(slide, source.image, source.alt, {
          x: MARGIN,
          y: top,
          w: inner,
          h: height - top - bottom,
        })
        if (source.caption) {
          slide.addText(source.caption, {
            x: MARGIN,
            y: height - 0.8,
            w: inner,
            h: 0.4,
            fontFace: FONT,
            fontSize: 12,
            color: hex(palette.muted),
            align: 'center',
          })
        }
        break
      }
      case 'quote':
        slide.addText(`“${source.quote}”`, {
          x: MARGIN + 0.4,
          y: height * 0.25,
          w: inner - 0.8,
          h: height * 0.4,
          fontFace: FONT,
          fontSize: 30,
          italic: true,
          color: hex(palette.text),
          align: 'center',
          valign: 'middle',
          fit: 'shrink',
        })
        if (source.attribution) {
          slide.addText(`— ${source.attribution}`, {
            x: MARGIN,
            y: height * 0.68,
            w: inner,
            h: 0.5,
            fontFace: FONT,
            fontSize: 16,
            color: hex(palette.muted),
            align: 'center',
          })
        }
        break
      case 'stats': {
        this.title(slide, source.title)
        const width = inner / source.stats.length
        const top = height * 0.4
        source.stats.forEach((stat, i) => {
          const x = MARGIN + i * width
          slide.addText(stat.value, {
            x,
            y: top,
            w: width,
            h: 1,
            fontFace: FONT,
            fontSize: 44,
            bold: true,
            color: hex(palette.accent),
            align: 'center',
            fit: 'shrink',
          })
          if (stat.label) {
            slide.addText(stat.label, {
              x,
              y: top + 1,
              w: width,
              h: 0.6,
              fontFace: FONT,
              fontSize: 16,
              color: hex(palette.muted),
              align: 'center',
              valign: 'top',
            })
          }
        })
        break
      }
      case 'table': {
        this.title(slide, source.title)
        const border = { type: 'solid' as const, pt: 0.75, color: hex(palette.line) }
        const header = source.columns.map((text) => ({
          text,
          options: { bold: true, fill: { color: hex(palette.surface) } },
        }))
        const rows = source.rows.map((row) => row.map((text) => ({ text })))
        slide.addTable([header, ...rows], {
          x: MARGIN,
          y: source.title ? BODY_TOP : TITLE_TOP,
          w: inner,
          colW: Array.from({ length: source.columns.length }, () => inner / source.columns.length),
          fontFace: FONT,
          fontSize: source.rows.length > 10 ? 11 : 14,
          color: hex(palette.text),
          border,
          autoPage: false,
        })
        break
      }
    }
    if (source.notes) slide.addNotes(source.notes)
  }
}

/** The deck's PowerPoint file. `images` holds the version's pictures by path. */
export async function slidesPptx(
  title: string,
  deck: Deck,
  images: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> {
  const pptx = new PptxGenJS()
  pptx.layout = deck.aspect === '4:3' ? 'LAYOUT_4x3' : 'LAYOUT_16x9'
  pptx.title = deck.title ?? title
  pptx.author = 'Kettu'
  const builder = new Builder(pptx, DECK_PALETTES[deck.theme ?? 'light'], images, deck.aspect)
  for (const slide of deck.slides) builder.add(slide)
  const written = await pptx.write({ outputType: 'nodebuffer' })
  if (!(written instanceof Uint8Array)) throw new Error('PowerPoint export gave no bytes')
  return new Uint8Array(written)
}
