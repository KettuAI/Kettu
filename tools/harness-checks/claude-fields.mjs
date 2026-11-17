// Kettu's own types for the Claude Agent SDK (src/agent-host/claude/sdk.ts), checked against an
// installed SDK's declarations: the fields Kettu names that the SDK's types have nowhere. A few of
// Kettu's are not in any published declaration, so a check compares the list for a new version
// with the one for the oldest version in the catalog's range, and only what is new fails it.

import { copyFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ROOT } from './kettu.mjs'

// Walks Kettu's types beside the SDK's, from the module's exports through objects, arrays,
// promises, async iterables and functions' parameters and results. A member of one of Kettu's
// unions tagged by `type` meets the SDK's members with the same tag, and is skipped when the SDK
// has none there, as for image blocks in a reply. Node.js's own types are not Kettu's to check.
const FIELDS = `import type { ChildProcess } from 'node:child_process'
import type * as Kettu from './kettu.mts'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

type Foreign = ChildProcess | AbortSignal | AbortController
type Steps = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
type Keys<S> = S extends unknown ? keyof S : never
type At<S, K extends PropertyKey> = S extends unknown ? (K extends keyof S ? S[K] : never) : never
type Elements<S> = S extends readonly (infer E)[] ? E : never
type Yields<S> = S extends AsyncIterable<infer E> ? E : never
type Resolves<S> = S extends PromiseLike<infer E> ? E : never
type Returns<S> = S extends (...args: never) => infer R ? R : never
type Takes<S, I extends PropertyKey> = S extends (...args: infer A) => unknown
  ? I extends keyof A ? A[I] : never
  : never
type Values<S> = S extends unknown ? (string extends keyof S ? S[string & keyof S] : never) : never
type Tag<T> = T extends { type: infer D extends string } ? (string extends D ? never : D) : never
type Matching<T, S> = [Tag<T>] extends [never] ? S : Extract<S, { type: Tag<T> }>
type Label<T> = [Tag<T>] extends [never] ? '' : \`<\${Tag<T>}>\`
type Name<K> = K extends string | number ? \`\${K}\` : never

type Lacks<T, S, P extends string, D extends number> = [D] extends [never]
  ? never
  : 0 extends 1 & S
    ? never
    : T extends Foreign
      ? never
      : T extends readonly (infer E)[]
        ? Inner<E, Elements<S>, \`\${P}[]\`, Steps[D]>
        : T extends PromiseLike<infer E>
          ? Inner<E, Resolves<S>, P, Steps[D]>
          : T extends (...args: infer A) => infer R
            ?
                | Inner<R, Returns<S>, \`\${P}()\`, Steps[D]>
                | {
                    [I in keyof A & \`\${number}\`]: Inner<A[I], Takes<S, I>, \`\${P}(\${I})\`, Steps[D]>
                  }[keyof A & \`\${number}\`]
            : T extends object
              ?
                  | (T extends AsyncIterable<infer E> ? Inner<E, Yields<S>, \`\${P}*\`, Steps[D]> : never)
                  | (string extends keyof T
                      ? Inner<T[string & keyof T], Values<S>, \`\${P}[*]\`, Steps[D]>
                      : never)
                  | {
                      [K in Exclude<keyof T, symbol>]-?: string extends K
                        ? never
                        : number extends K
                          ? never
                          : K extends Keys<S>
                            ? Inner<NonNullable<T[K]>, NonNullable<At<S, K>>, \`\${P}.\${Name<K>}\`, Steps[D]>
                            : \`\${P}.\${Name<K>}\`
                    }[Exclude<keyof T, symbol>]
              : never

type Inner<T, S, P extends string, D extends number> = T extends unknown
  ? [Matching<T, S>] extends [never]
    ? never
    : Lacks<T, NonNullable<Matching<T, S>>, \`\${P}\${Label<T>}\`, D>
  : never

export type Lacking = Lacks<Kettu.ClaudeSdk, Sdk, 'sdk', 10>
`

/**
 * The paths of the fields Kettu names that the SDK installed in `dir` declares nowhere, such as
 * `sdk.query().initializationResult().claude_code_version`. Throws when the check itself does
 * not compile, as when the SDK no longer exports what it walks from.
 */
export async function lackingFields(dir) {
  const require = createRequire(path.join(ROOT, 'package.json'))
  const ts = require('typescript')
  const fields = path.join(dir, 'fields.mts')
  const kettu = path.join(dir, 'kettu.mts')
  await copyFile(path.join(ROOT, 'src/agent-host/claude/sdk.ts'), kettu)
  await writeFile(fields, FIELDS)
  const program = ts.createProgram([fields], {
    target: ts.ScriptTarget.ES2024,
    lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [path.join(ROOT, 'node_modules/@types')],
    types: ['node'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
  })
  const own = new Set([fields, kettu])
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || own.has(path.resolve(d.file.fileName)))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  if (errors.length > 0)
    throw new Error(`The SDK's types do not compile with Kettu's: ${errors.join('; ')}`)
  const file = program.getSourceFile(fields)
  const alias = file.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Lacking',
  )
  const type = program.getTypeChecker().getTypeAtLocation(alias.name)
  const parts = type.isUnion() ? type.types : [type]
  if (parts.some((part) => !part.isStringLiteral() && !(part.flags & ts.TypeFlags.Never))) {
    throw new Error('The field check did not resolve to a list of paths')
  }
  return parts
    .filter((part) => part.isStringLiteral())
    .map((part) => part.value)
    .sort()
}
