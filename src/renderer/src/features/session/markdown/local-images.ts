// Images that name local files: their spaces before parsing, their URLs after.

interface MdNode {
  type: string
  url?: string
  children?: MdNode[]
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE = /^[a-z]:[\\/]/i
const FILE_URI = /^file:/i
const PREFIX = '/#local-image:'

/**
 * `![alt](path)` as agents write paths such as `~/Library/Application Support/...`: an absolute or
 * `./` path, with no parenthesis, angle bracket or line break, that ends in a media file's
 * extension and is closed by `)`.
 */
const LOCAL_IMAGE =
  /!\[([^\]\n]*)\]\(((?:\/(?!\/)|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])[^()<>\n]*\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|mp4|m4v|webm|mov|mkv))\)/gi
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INDENTED = /^(?: {4}|\t)/
// Inside `<...>` a backslash before punctuation escapes it, which would eat a Windows separator.
const ESCAPABLE = /\\(?=[!-/:-@[-`{-~])/g

function wrapImages(prose: string): string {
  return prose.replace(LOCAL_IMAGE, (image, alt: string, path: string) =>
    /\s/.test(path) ? `![${alt}](<${path.replace(ESCAPABLE, '\\\\')}>)` : image,
  )
}

/** `wrapImages` on the text outside code spans, which pair backtick runs of the same length. */
function outsideCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)]
  let out = ''
  let done = 0
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!
    const j = runs.findIndex((run, k) => k > i && run[0].length === open[0].length)
    if (j === -1) continue
    const end = runs[j]!.index + runs[j]![0].length
    out += wrapImages(text.slice(done, open.index)) + text.slice(open.index, end)
    done = end
    i = j
  }
  return out + wrapImages(text.slice(done))
}

/**
 * Writes the destination of a local image whose path has a space as `<...>`, the form in which
 * CommonMark takes spaces, before the text is parsed. Code blocks, lines indented as code and
 * code spans stay as written.
 */
export function spacedImages(markdown: string): string {
  LOCAL_IMAGE.lastIndex = 0
  if (!LOCAL_IMAGE.test(markdown)) return markdown
  let out = ''
  let prose = ''
  let fence: string | null = null
  for (const line of markdown.split(/(?<=\n)/)) {
    if (fence !== null) {
      out += line
      const close = FENCE.exec(line)
      const closes =
        close !== null &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        line.slice(close[0].length).trim() === ''
      if (closes) fence = null
      continue
    }
    const open = FENCE.exec(line)
    if (open || INDENTED.test(line)) {
      out += outsideCodeSpans(prose) + line
      prose = ''
      if (open) fence = open[1]!
      continue
    }
    prose += line
  }
  return out + outsideCodeSpans(prose)
}

/** Whether an image's URL names a local file, which `localImages` marks. */
export function isLocalImage(url: string): boolean {
  if (url === '' || url.startsWith('#') || url.startsWith('//')) return false
  return !SCHEME.test(url) || DRIVE.test(url) || FILE_URI.test(url)
}

/**
 * Image hardening blocks a local path that does not start with `/` and drops any attribute of our
 * own, so a local image carries its path in the fragment of a root-relative URL, the one form it
 * lets through unchanged. `localImageTarget` reads it back.
 */
export function localImages() {
  const visit = (node: MdNode): void => {
    if (node.type === 'image' && node.url !== undefined && isLocalImage(node.url)) {
      node.url = PREFIX + encodeURIComponent(node.url)
      return
    }
    node.children?.forEach(visit)
  }
  return visit
}

/** The local path of an image `localImages` rewrote, else null. */
export function localImageTarget(src: string): string | null {
  if (!src.startsWith(PREFIX)) return null
  try {
    return decodeURIComponent(src.slice(PREFIX.length))
  } catch {
    return null
  }
}
