// The type packages the host knows: each type's content format and its versions, the guidance
// agents read, what its viewer may use and what it exports to. Every write of an artifact made
// from a type is checked here against its format.

import { isImagePath } from '@shared/artifact-document'
import {
  CONTENT_ENTRIES,
  type ArtifactExportFormat,
  type ArtifactTypeInfo,
  type ArtifactTypeName,
  EXPORT_FORMATS,
} from '@shared/artifact-types'
import { documentType } from './document'
import { imageInfo } from './images'
import { slidesType } from './slides'

/** A version's files as a type checks them: all its paths, its content's text, what changed. */
export interface ContentDraft {
  paths: ReadonlySet<string>
  /** The entry file's text; null when it is missing or not UTF-8. */
  entry: string | null
  /** The files this write puts in place, with their bytes. */
  changed: ReadonlyMap<string, Uint8Array>
}

/** One version of a type's content format. */
export interface TypeFormat {
  /** What is wrong with the draft beyond the checks every type shares; empty when nothing. */
  check(draft: ContentDraft): string[]
  /**
   * The content of the format before this one, moved to this one; throws when it cannot be,
   * and the artifact keeps the old format and its viewer.
   */
  migrate?(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array>
}

/** A reference page an agent reads when it needs the detail. */
export interface TypeReference {
  title: string
  text: string
}

export interface TypePackage {
  name: ArtifactTypeName
  title: string
  /** One line on what it is for, which list_artifact_types gives. */
  summary: string
  /** The formats it has had, by version; the highest is the current one. */
  formats: Readonly<Record<number, TypeFormat>>
  /** The process and the hard rules; the detail is in the references. */
  guidance: string
  references: Readonly<Record<string, TypeReference>>
  /** The runtime capabilities its viewer uses, which every artifact of the type has. */
  capabilities: readonly string[]
  exports: readonly ArtifactExportFormat[]
}

export const BUILT_IN_TYPES: readonly TypePackage[] = [documentType, slidesType]

/** The content of a typed artifact does not fit its format; `problems` says where and why. */
export class ContentError extends Error {
  constructor(
    readonly type: ArtifactTypeName,
    readonly problems: readonly string[],
  ) {
    super(problems.join(' '))
    this.name = 'ContentError'
  }
}

export class ArtifactTypes {
  private readonly byName: Map<string, TypePackage>

  constructor(packages: readonly TypePackage[] = BUILT_IN_TYPES) {
    this.byName = new Map(packages.map((type) => [type.name, type]))
  }

  list(): TypePackage[] {
    return [...this.byName.values()]
  }

  get(name: string): TypePackage | null {
    return this.byName.get(name) ?? null
  }

  /** The format new content of the type is written in. */
  current(name: ArtifactTypeName): number {
    const type = this.must(name)
    return Math.max(...Object.keys(type.formats).map(Number))
  }

  capabilities(name: ArtifactTypeName): readonly string[] {
    return this.get(name)?.capabilities ?? []
  }

  exports(name: ArtifactTypeName): readonly ArtifactExportFormat[] {
    return this.get(name)?.exports ?? EXPORT_FORMATS[name]
  }

  private must(name: string): TypePackage {
    const type = this.get(name)
    if (!type) throw new Error(`No artifact type ${name}`)
    return type
  }

  /** Throws a ContentError with every problem of the draft as `type` content. */
  check(type: ArtifactTypeInfo, draft: ContentDraft): void {
    const format = this.must(type.name).formats[type.format]
    if (!format) throw new Error(`${type.name} has no format ${type.format}`)
    const entry = CONTENT_ENTRIES[type.name]
    const problems: string[] = []
    const others = [...draft.paths].filter((path) => path !== entry && !isImagePath(path))
    if (others.length > 0) {
      problems.push(
        `A ${type.name} holds only ${entry} and PNG, JPEG or GIF pictures under images/; ` +
          `remove ${others.slice(0, 5).join(', ')}${others.length > 5 ? ' and more' : ''}.`,
      )
    }
    if (!draft.paths.has(entry)) problems.push(`${entry} is missing; give it in files.`)
    else if (draft.entry === null) problems.push(`${entry} is not UTF-8 text.`)
    for (const [path, bytes] of draft.changed) {
      if (!isImagePath(path)) continue
      const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      const kind = imageInfo(bytes)?.type ?? null
      const expected = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension
      if (kind !== expected) {
        problems.push(
          `${path} is not a ${expected.toUpperCase()} picture${kind ? ` but a ${kind.toUpperCase()}` : ''}; ` +
            'give it the extension of its kind.',
        )
      }
    }
    if (problems.length === 0) problems.push(...format.check(draft))
    if (problems.length > 0) throw new ContentError(type.name, problems)
  }

  /**
   * The content moved from `from`'s format to the current one, step by step, with the format it is
   * in now; the same files when it is current. Throws when a step cannot move it.
   */
  migrate(
    from: ArtifactTypeInfo,
    files: ReadonlyMap<string, Uint8Array>,
  ): { format: number; files: Map<string, Uint8Array> } {
    const type = this.must(from.name)
    const current = this.current(from.name)
    let moved = new Map(files)
    for (let next = from.format + 1; next <= current; next++) {
      const step = type.formats[next]?.migrate
      if (!step) throw new Error(`${from.name} format ${next} cannot take format ${next - 1}`)
      moved = step(moved)
    }
    return { format: current, files: moved }
  }
}
