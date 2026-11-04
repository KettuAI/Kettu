// The slides type: a deck of laid-out slides in JSON with pictures, paged through and presented,
// and exported to PowerPoint and PDF.

import { isImagePath } from '@shared/artifact-document'
import { LAYOUT_FIELDS, LIMITS, parseDeck, SLIDE_LAYOUTS } from '@shared/artifact-slides'
import type { ContentDraft, TypePackage } from './registry'

function checkSlides(draft: ContentDraft): string[] {
  const images = new Set([...draft.paths].filter(isImagePath))
  const parsed = parseDeck(draft.entry ?? '', images)
  return 'problems' in parsed ? parsed.problems : []
}

const GUIDANCE =
  'A slide deck is JSON in slides.json, with its pictures under images/. Kettu shows it a slide ' +
  'at a time, presents it full screen, lets the user edit its text and exports it to PowerPoint ' +
  '(.pptx) and PDF. To make one: write slides.json as {"title": "...", "slides": [...]}, each ' +
  'slide an object with a layout and that layout’s fields (read the layouts reference first); ' +
  'give each picture in files as images/<name>.png (PNG, JPEG or GIF), with source when it is a ' +
  'file in your working directory; then call create_artifact_from_type with type slides. To ' +
  'change it, read_artifact and update_artifact as for any artifact: edits on slides.json for a ' +
  'few words, or the whole file in files. Hard rules: a deck holds only slides.json and pictures ' +
  'under images/; text is plain, with no Markdown or HTML; Kettu lays the slides out, so give no ' +
  'positions, sizes or colors; every write is checked, and a refusal names the field to fix. The ' +
  'references deck, layouts and images give the detail.'

const DECK =
  'slides.json holds {"title": "Quarterly review", "theme": "light", "aspect": "16:9", "slides": ' +
  '[...]}. title is optional and names the deck in exports. theme is light (dark text on white, ' +
  'the default) or dark (light text on near black). aspect is 16:9 (the default) or 4:3. slides ' +
  `lists 1 to ${LIMITS.slides} slides, each with "layout" and the fields of that layout, plus an ` +
  'optional "notes" with what the presenter says, which goes into the PowerPoint notes. Text is ' +
  'plain; a new line in it is "\\n". Limits: a title ' +
  `${LIMITS.title} characters, other text ${LIMITS.text}, a point ${LIMITS.bullet}, ` +
  `${LIMITS.bullets} points on a slide with ${LIMITS.subBullets} under each, notes ` +
  `${LIMITS.notes}. A slide is read in seconds: a title of a few words, at most six points of a ` +
  'line each, one idea per slide; start with a title slide and use section slides between parts.'

const LAYOUT_EXAMPLES: Record<(typeof SLIDE_LAYOUTS)[number], string> = {
  title: '{"layout": "title", "title": "Kettu", "subtitle": "Q3 review · October 2026"}',
  section: '{"layout": "section", "title": "Results", "subtitle": "What changed this quarter"}',
  bullets:
    '{"layout": "bullets", "title": "Why now", "bullets": ["Teams ship weekly", {"text": "Costs ' +
    'fell", "bullets": ["Hosting -30%", "Support -12%"]}], "image": "images/trend.png", "alt": ' +
    '"Costs by month"}; with image, the picture sits on the right of the points',
  'two-column':
    '{"layout": "two-column", "title": "Before and after", "left": {"heading": "Before", ' +
    '"bullets": ["Manual deploys"]}, "right": {"heading": "After", "text": "One click."}}; each ' +
    'side takes heading, and text or bullets',
  image:
    '{"layout": "image", "title": "Sign-ups", "image": "images/signups.png", "alt": "Sign-ups ' +
    'per week, rising", "caption": "Source: analytics"}; the picture fills the slide below the title',
  quote: '{"layout": "quote", "quote": "It just works.", "attribution": "A customer"}',
  stats:
    '{"layout": "stats", "title": "In numbers", "stats": [{"value": "42%", "label": "faster"}, ' +
    `{"value": "3x", "label": "more users"}]}; 1 to ${LIMITS.stats} figures`,
  table:
    '{"layout": "table", "title": "Plans", "columns": ["Plan", "Price"], "rows": [["Free", "$0"], ' +
    `["Pro", "$9"]]}; 1 to ${LIMITS.columns} columns and at most ${LIMITS.rows} rows, each row as ` +
    'many cells as columns',
}

const LAYOUTS = SLIDE_LAYOUTS.map((layout) => {
  const { required, optional } = LAYOUT_FIELDS[layout]
  const fields = [...required, ...optional.map((field) => `${field} (optional)`)].join(', ')
  return `${layout}: ${fields}. Example: ${LAYOUT_EXAMPLES[layout]}.`
}).join(' ')

const IMAGES =
  'Pictures are PNG, JPEG or GIF files under images/, such as images/chart.png; their extension ' +
  'must match their kind, and SVG is not taken. Give each in files with source, the path of the ' +
  'file in your working directory, so its bytes never pass through you; one file is at most 20 ' +
  'MiB, a version 64 MiB and 256 files. A slide names a picture by its path in "image", with ' +
  '"alt" saying what it shows; every picture a slide names must be a file of the version. A chart ' +
  'reads best drawn at the size it shows, about 1200 by 600 pixels for an image slide.'

export const slidesType: TypePackage = {
  name: 'slides',
  title: 'Slides',
  summary: 'A slide deck to present: laid-out slides in JSON, exported to PowerPoint and PDF.',
  formats: { 1: { check: checkSlides } },
  guidance: GUIDANCE,
  references: {
    deck: { title: 'The deck', text: DECK },
    layouts: { title: 'Layouts', text: `Each slide's layout and its fields. ${LAYOUTS}` },
    images: { title: 'Pictures', text: IMAGES },
  },
  capabilities: ['content'],
  exports: ['pptx', 'pdf'],
}
