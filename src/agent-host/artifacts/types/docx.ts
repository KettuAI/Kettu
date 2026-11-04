// A document artifact as a Word file: its Markdown read block by block into Word's headings,
// paragraphs, lists, tables and pictures. Loaded with the first export.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { GFM, parser } from '@lezer/markdown'
import { imagePathOf } from '@shared/artifact-document'
import { imageInfo } from './images'

const markdown = parser.configure(GFM)

type SyntaxNode = ReturnType<typeof markdown.parse>['topNode']

/** The widest a picture is set, in pixels at 96 to the inch: the page between its margins. */
const PAGE_WIDTH_PX = 600
/** The text's width on an A4 or Letter page with Word's margins, in twentieths of a point. */
const TEXT_WIDTH_TWIPS = 9000
const MONO = 'Consolas'
const ORDERED = 'ordered'
const LINE_COLOR = 'C9CDD3'
const CODE_FILL = 'F3F4F6'

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

const MARKS = new Set([
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'TableDelimiter',
  'URL',
  'LinkTitle',
  'LinkLabel',
  'CodeInfo',
])

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': '\u00a0',
}

interface Style {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
}

type Block = Paragraph | Table

class Converter {
  private lists = 0

  constructor(
    private readonly text: string,
    private readonly images: ReadonlyMap<string, Uint8Array>,
  ) {}

  private slice(node: { from: number; to: number }): string {
    return this.text.slice(node.from, node.to)
  }

  private run(text: string, style: Style): TextRun {
    return new TextRun({
      text,
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      ...(style.code ? { font: MONO, shading: { type: ShadingType.CLEAR, fill: CODE_FILL } } : {}),
    })
  }

  /** The runs of a block's inline content, between `from` and `to`. */
  inlines(node: SyntaxNode, style: Style = {}, from = node.from, to = node.to): ParagraphChild[] {
    const out: ParagraphChild[] = []
    const plain = (start: number, end: number) => {
      if (end <= start) return
      let text = this.text.slice(start, end).replace(/[ \t]*\n[ \t]*/g, ' ')
      // The blank after a block's marks, such as a heading's # or a task's box, is no text.
      if (out.length === 0) text = text.trimStart()
      if (text) out.push(this.run(text, style))
    }
    let at = from
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue
      plain(at, child.from)
      at = child.to
      out.push(...this.inline(child, style))
    }
    plain(at, to)
    return out
  }

  private inline(node: SyntaxNode, style: Style): ParagraphChild[] {
    switch (node.name) {
      case 'Emphasis':
        return this.inlines(node, { ...style, italics: true })
      case 'StrongEmphasis':
        return this.inlines(node, { ...style, bold: true })
      case 'Strikethrough':
        return this.inlines(node, { ...style, strike: true })
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark')
        const start = marks[0]?.to ?? node.from
        const end = marks.length > 1 ? marks.at(-1)!.from : node.to
        return [this.run(this.text.slice(start, end), { ...style, code: true })]
      }
      case 'Link': {
        const url = node.getChild('URL')
        const label = this.inlines(node, style)
        const href = url ? this.slice(url) : ''
        if (!/^https?:\/\//i.test(href)) return label
        return [new ExternalHyperlink({ link: href, children: this.linked(node, style) })]
      }
      case 'URL':
      case 'Autolink': {
        const url = node.name === 'URL' ? node : node.getChild('URL')
        const href = url ? this.slice(url) : ''
        return [
          /^https?:\/\//i.test(href)
            ? new ExternalHyperlink({ link: href, children: [this.linkRun(href, style)] })
            : this.run(href, style),
        ]
      }
      case 'Image':
        return [this.image(node)]
      case 'Escape':
        return [this.run(this.slice(node).slice(1), style)]
      case 'Entity': {
        const entity = this.slice(node)
        return [this.run(ENTITIES[entity] ?? entity, style)]
      }
      case 'HardBreak':
        return [new TextRun({ text: '', break: 1 })]
      case 'HTMLTag':
      case 'Comment':
        return []
      default:
        return MARKS.has(node.name) ? [] : this.inlines(node, style)
    }
  }

  private linkRun(text: string, style: Style): TextRun {
    return new TextRun({ text, style: 'Hyperlink', bold: style.bold, italics: style.italics })
  }

  /** A link's label as the hyperlink's runs, which Word styles as a link. */
  private linked(node: SyntaxNode, style: Style): TextRun[] {
    const marks = node.getChildren('LinkMark')
    const start = marks[0]?.to ?? node.from
    const end = marks[1]?.from ?? node.to
    const text = this.text
      .slice(start, end)
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
    return [this.linkRun(text, style)]
  }

  private image(node: SyntaxNode): ParagraphChild {
    const url = node.getChild('URL')
    const marks = node.getChildren('LinkMark')
    const alt = this.text.slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.from)
    const path = url ? imagePathOf(this.slice(url).replace(/^<|>$/g, '')) : null
    const bytes = path ? this.images.get(path) : undefined
    const info = bytes ? imageInfo(bytes) : null
    if (!bytes || !info || info.width === 0 || info.height === 0) {
      return new TextRun({ text: alt ? `[${alt}]` : '', italics: true })
    }
    const scale = Math.min(1, PAGE_WIDTH_PX / info.width)
    return new ImageRun({
      type: info.type === 'jpeg' ? 'jpg' : info.type,
      data: bytes,
      transformation: {
        width: Math.round(info.width * scale),
        height: Math.round(info.height * scale),
      },
      altText: { name: path ?? 'picture', description: alt, title: alt },
    })
  }

  /** The content after a heading's marks. */
  private heading(node: SyntaxNode, level: number): Paragraph {
    const mark = node.getChild('HeaderMark')
    const atx = node.name.startsWith('ATX')
    const from = atx && mark ? mark.to : node.from
    const closing = atx
      ? node.getChildren('HeaderMark').slice(1).at(0)
      : node.getChild('HeaderMark')
    const to = closing && closing.from > from ? closing.from : node.to
    const children = this.inlines(node, {}, from, to)
    return new Paragraph({ heading: HEADINGS[Math.min(level, 6) - 1], children })
  }

  blocks(node: SyntaxNode, depth = 0, quoted = false): Block[] {
    const out: Block[] = []
    for (let child = node.firstChild; child; child = child.nextSibling) {
      out.push(...this.block(child, depth, quoted))
    }
    return out
  }

  private block(node: SyntaxNode, depth: number, quoted: boolean): Block[] {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)
    if (heading) return [this.heading(node, Number(heading[1]))]
    const quote = quoted
      ? {
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: LINE_COLOR, space: 8 } },
        }
      : {}
    switch (node.name) {
      case 'Paragraph':
        return [new Paragraph({ ...quote, children: this.inlines(node) })]
      case 'Blockquote':
        return this.blocks(node, depth, true)
      case 'BulletList':
      case 'OrderedList':
        return this.list(node, depth, node.name === 'OrderedList')
      case 'FencedCode':
      case 'CodeBlock':
        return this.code(node)
      case 'HorizontalRule':
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE_COLOR, space: 1 } },
            children: [],
          }),
        ]
      case 'Table':
        return [this.table(node)]
      case 'HTMLBlock':
      case 'LinkReference':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        return []
      default:
        return this.blocks(node, depth, quoted)
    }
  }

  private list(node: SyntaxNode, depth: number, ordered: boolean): Block[] {
    const instance = ordered ? ++this.lists : 0
    const out: Block[] = []
    for (let item = node.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue
      let first = true
      for (let child = item.firstChild; child; child = child.nextSibling) {
        if (child.name === 'ListMark') continue
        if (first && (child.name === 'Paragraph' || child.name === 'Task')) {
          first = false
          const task = child.name === 'Task' ? child.getChild('TaskMarker') : null
          const box = task ? (/x/i.test(this.slice(task)) ? '☑ ' : '☐ ') : ''
          const children = this.inlines(child)
          out.push(
            new Paragraph({
              ...(ordered
                ? { numbering: { reference: ORDERED, level: Math.min(depth, 8), instance } }
                : { bullet: { level: Math.min(depth, 8) } }),
              children: box ? [new TextRun(box), ...children] : children,
            }),
          )
          continue
        }
        first = false
        out.push(...this.block(child, depth + 1, false))
      }
    }
    return out
  }

  private code(node: SyntaxNode): Paragraph[] {
    let text: string
    if (node.name === 'FencedCode') {
      const body = node.getChild('CodeText')
      text = body ? this.slice(body) : ''
    } else {
      text = this.slice(node)
        .split('\n')
        .map((line) => line.replace(/^ {4}|^\t/, ''))
        .join('\n')
    }
    return text.split('\n').map(
      (line) =>
        new Paragraph({
          spacing: { before: 0, after: 0 },
          shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
          children: [new TextRun({ text: line, font: MONO, size: 19 })],
        }),
    )
  }

  private table(node: SyntaxNode): Table {
    const rows = [...node.getChildren('TableHeader'), ...node.getChildren('TableRow')]
    const columns = Math.max(1, ...rows.map((row) => row.getChildren('TableCell').length))
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: Array.from({ length: columns }, () => Math.floor(TEXT_WIDTH_TWIPS / columns)),
      rows: rows.map((row) => {
        const header = row.name === 'TableHeader'
        const cells = row.getChildren('TableCell')
        return new TableRow({
          tableHeader: header,
          // A row with fewer cells than the header is filled out, as a Markdown table shows it.
          children: Array.from({ length: columns }, (_, i) => {
            const cell = cells[i]
            return new TableCell({
              ...(header ? { shading: { type: ShadingType.CLEAR, fill: CODE_FILL } } : {}),
              children: [
                new Paragraph({
                  children: cell ? this.inlines(cell, header ? { bold: true } : {}) : [],
                }),
              ],
            })
          }),
        })
      }),
    })
  }
}

/** The document's Word file. `images` holds the version's pictures by path. */
export async function documentDocx(
  title: string,
  text: string,
  images: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> {
  const converter = new Converter(text, images)
  const children = converter.blocks(markdown.parse(text).topNode)
  const document = new Document({
    title,
    creator: 'Kettu',
    styles: {
      default: { document: { paragraph: { spacing: { after: 120, line: 276 } } } },
    },
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][
              level % 3
            ]!,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: children.length > 0 ? children : [new Paragraph('')] }],
  })
  return new Uint8Array(await Packer.toBuffer(document))
}
