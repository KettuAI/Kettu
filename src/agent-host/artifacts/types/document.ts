// The document type: Markdown with pictures, shown in a reading layout and exported to Word and
// Markdown.

import { imagePathOf, isImagePath, markdownImages } from '@shared/artifact-document'
import type { ContentDraft, TypePackage } from './registry'

/** The pictures the Markdown shows that are not files of the version, by line. */
function checkDocument(draft: ContentDraft): string[] {
  const problems: string[] = []
  for (const image of markdownImages(draft.entry ?? '')) {
    const path = imagePathOf(image.target)
    const at = `document.md line ${image.line}`
    if (path === null) {
      problems.push(
        `${at} shows ${image.target}, which is not a file of the artifact; add the picture in ` +
          'files as images/<name>.png and show it as images/<name>.png.',
      )
    } else if (!isImagePath(path)) {
      problems.push(`${at} shows ${path}; pictures are PNG, JPEG or GIF files under images/.`)
    } else if (!draft.paths.has(path)) {
      problems.push(`${at} shows ${path}, which the version does not have; add it in files.`)
    }
  }
  return problems
}

const GUIDANCE =
  'A document is Markdown in document.md, with its pictures under images/. Kettu shows it in a ' +
  'reading layout, the user can edit its text there, and it exports to Word (.docx) and Markdown. ' +
  'To make one: write the whole text as Markdown in document.md, starting with one # heading; ' +
  'give each picture in files as images/<name>.png (PNG, JPEG or GIF), with source when it is a ' +
  'file in your working directory, and show it with ![what it shows](images/<name>.png); then call ' +
  'create_artifact_from_type with type document. To change it, read_artifact and update_artifact ' +
  'as for any artifact, with edits on document.md. Hard rules: a document holds only document.md ' +
  'and pictures under images/; pictures come from its own files, never from URLs; raw HTML is not ' +
  'shown; every write is checked, and a refusal says what to fix. The references markdown and ' +
  'images give the detail.'

const MARKDOWN =
  'document.md is CommonMark with GitHub tables, strikethrough and task lists. Kettu shows ' +
  'headings # to ######, paragraphs, *emphasis*, **strong**, ~~strikethrough~~, `code`, links, ' +
  'bullet, numbered and task lists (nested by indenting), > quotes, fenced code blocks with a ' +
  'language for colors, tables, --- rules and pictures. Raw HTML, footnotes and maths are left as ' +
  'text or not shown. Links open in the browser after the user confirms; write them in full, such ' +
  'as https://example.com. For Word, headings become Word headings, lists and tables stay lists ' +
  'and tables, code is set in a monospace face and pictures keep their size up to the page width. ' +
  'Write for reading: short sections under ## headings, paragraphs of a few sentences, a table ' +
  'where the reader compares, a picture where it shows more than words.'

const IMAGES =
  'Pictures are PNG, JPEG or GIF files under images/, such as images/chart.png or ' +
  'images/screens/login.png; their extension must match their kind, and SVG is not taken. Give ' +
  'each in files with source, the path of the file in your working directory, so its bytes never ' +
  'pass through you; one file is at most 20 MiB, and a version 64 MiB and 256 files. Show one ' +
  'with ![what it shows](images/chart.png) on a line of its own; the text in brackets is read ' +
  'aloud and shown when the picture cannot be. A version may keep pictures the text does not ' +
  'show, but every picture the text shows must be a file of the version. To remove one, give ' +
  '{"path": "images/old.png", "remove": true} in update_artifact and take it out of the text.'

export const documentType: TypePackage = {
  name: 'document',
  title: 'Document',
  summary: 'A document to read: Markdown with pictures, exported to Word and Markdown.',
  formats: { 1: { check: checkDocument } },
  guidance: GUIDANCE,
  references: {
    markdown: { title: 'What Markdown shows', text: MARKDOWN },
    images: { title: 'Pictures', text: IMAGES },
  },
  capabilities: ['content'],
  exports: ['docx', 'md'],
}
