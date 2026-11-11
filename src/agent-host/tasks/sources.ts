// Where workflows come from: the ones Kettu ships, a project's `.kettu/workflows/` on its
// default branch, and the user's own library. A project's workflows are read from git objects,
// never from a working tree, so an agent editing files on a branch cannot change the rules it
// runs under.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Workflow, WorkflowSource, WorkflowSummary } from '@shared/tasks'
import { invalidParams, notFound } from '../errors'
import { GIT_TIMEOUT_MS, type Exec } from '../git/exec'
import { OFFICIAL_WORKFLOWS } from './official'
import { parseWorkflow, summarize, unreadable, WORKFLOW_FILE_BYTES, workflowHash } from './workflow'

export const PROJECT_WORKFLOWS_DIR = '.kettu/workflows'

/** A workflow file as read, or why it could not be read. */
export type WorkflowFile = { file: string; text: string } | { file: string; problem: string }

export interface WorkflowSourceDeps {
  exec: Exec
  /** The user's own workflows, `<userData>/workflows`; null for none. */
  libraryDir: string | null
  /** Reads the library's YAML files; the default reads the folder from disk. */
  readLibrary?: (dir: string) => Promise<WorkflowFile[]>
}

interface Entry {
  source: WorkflowSource
  file: string
  text: string | null
  read: { workflow: Workflow } | { problem: string }
}

function isYaml(name: string): boolean {
  return /\.ya?ml$/i.test(name)
}

function baseName(file: string): string {
  return file.replace(/\.ya?ml$/i, '')
}

async function readLibraryDir(dir: string): Promise<WorkflowFile[]> {
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isYaml(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  return Promise.all(
    names.sort().map(async (file): Promise<WorkflowFile> => {
      const target = path.join(dir, file)
      try {
        if ((await stat(target)).size > WORKFLOW_FILE_BYTES) {
          return { file, problem: `the file is larger than ${WORKFLOW_FILE_BYTES / 1024} KB` }
        }
        return { file, text: await readFile(target, 'utf8') }
      } catch (error) {
        return { file, problem: `could not be read: ${(error as Error).message}` }
      }
    }),
  )
}

/**
 * The full name of the project's default branch: the remote's HEAD, else `main` or `master` on
 * the remote and then locally. Null outside a git repository or when none exists.
 */
export async function defaultBranchRef(exec: Exec, projectPath: string): Promise<string | null> {
  const candidates = [
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master',
  ]
  const result = await exec(
    'git',
    ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes/origin/HEAD', ...candidates],
    { cwd: projectPath, timeoutMs: GIT_TIMEOUT_MS },
  )
  if (result.failure !== null || result.code !== 0) return null
  const refs = new Set<string>()
  let remoteHead: string | null = null
  for (const line of result.stdout.split('\n')) {
    const [refname, symref] = line.split('\0')
    if (!refname) continue
    refs.add(refname)
    if (refname === 'refs/remotes/origin/HEAD' && symref) remoteHead = symref
  }
  if (remoteHead !== null) {
    const there = await exec('git', ['rev-parse', '--verify', '--quiet', remoteHead], {
      cwd: projectPath,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (there.failure === null && there.code === 0) return remoteHead
  }
  return candidates.find((ref) => refs.has(ref)) ?? null
}

async function readProject(exec: Exec, projectPath: string): Promise<WorkflowFile[]> {
  const ref = await defaultBranchRef(exec, projectPath)
  if (ref === null) return []
  const git = (args: string[]) => exec('git', args, { cwd: projectPath, timeoutMs: GIT_TIMEOUT_MS })
  const listed = await git(['ls-tree', '-z', '--long', ref, '--', `${PROJECT_WORKFLOWS_DIR}/`])
  if (listed.failure !== null || listed.code !== 0) return []
  const files: WorkflowFile[] = []
  for (const line of listed.stdout.split('\0')) {
    // <mode> <type> <object> <size>\t<path>
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, object, size] = line.slice(0, tab).trim().split(/\s+/)
    const file = path.posix.basename(line.slice(tab + 1))
    // Only plain files: a symbolic link's blob is its target's path, not the workflow.
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !isYaml(file)) continue
    if (Number(size) > WORKFLOW_FILE_BYTES) {
      files.push({ file, problem: `the file is larger than ${WORKFLOW_FILE_BYTES / 1024} KB` })
      continue
    }
    const blob = await git(['cat-file', 'blob', object!])
    if (blob.failure !== null || blob.code !== 0) {
      files.push({ file, problem: `could not be read from ${ref}` })
      continue
    }
    files.push({ file, text: blob.stdout })
  }
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

async function entriesOf(
  source: WorkflowSource,
  projectPath: string | null,
  deps: WorkflowSourceDeps,
): Promise<Entry[]> {
  let files: readonly WorkflowFile[]
  if (source === 'official') files = OFFICIAL_WORKFLOWS
  else if (source === 'project')
    files = projectPath ? await readProject(deps.exec, projectPath) : []
  else if (deps.libraryDir === null) files = []
  else files = await (deps.readLibrary ?? readLibraryDir)(deps.libraryDir)

  const entries = files.map((file): Entry => {
    if ('problem' in file) {
      return { source, file: file.file, text: null, read: { problem: file.problem } }
    }
    return { source, file: file.file, text: file.text, read: parseWorkflow(file.text) }
  })
  // Two files of one source with the same id: the first by file name keeps it.
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!('workflow' in entry.read)) continue
    const { id } = entry.read.workflow
    if (seen.has(id)) entry.read = { problem: `another file defines the workflow "${id}"` }
    else seen.add(id)
  }
  return entries
}

function summaryOf(entry: Entry): WorkflowSummary {
  return 'workflow' in entry.read
    ? summarize(entry.read.workflow, entry.source)
    : unreadable(entry.source, baseName(entry.file), entry.read.problem)
}

/**
 * Every workflow the picker offers for a project, the project's own first. A project workflow
 * replaces any other source's workflow with the same id; files that did not read are listed with
 * their problem.
 */
export async function listWorkflows(
  projectPath: string | null,
  deps: WorkflowSourceDeps,
): Promise<WorkflowSummary[]> {
  const [project, library, official] = await Promise.all([
    entriesOf('project', projectPath, deps),
    entriesOf('library', projectPath, deps),
    entriesOf('official', projectPath, deps),
  ])
  const overridden = new Set(
    project.flatMap((entry) => ('workflow' in entry.read ? [entry.read.workflow.id] : [])),
  )
  const shadowed = (entry: Entry): boolean =>
    'workflow' in entry.read && overridden.has(entry.read.workflow.id)
  return [
    ...project,
    ...library.filter((entry) => !shadowed(entry)),
    ...official.filter((entry) => !shadowed(entry)),
  ].map(summaryOf)
}

/** Reads one workflow fresh, with the hash of its file. Throws when it is missing or invalid. */
export async function readWorkflow(
  projectPath: string | null,
  source: WorkflowSource,
  id: string,
  deps: WorkflowSourceDeps,
): Promise<{ workflow: Workflow; hash: string }> {
  const entries = await entriesOf(source, projectPath, deps)
  for (const entry of entries) {
    if ('workflow' in entry.read && entry.read.workflow.id === id) {
      return { workflow: entry.read.workflow, hash: workflowHash(entry.text!) }
    }
  }
  const broken = entries.find((entry) => 'problem' in entry.read && baseName(entry.file) === id)
  if (broken && 'problem' in broken.read) {
    throw invalidParams(`The ${source} workflow "${id}" is invalid: ${broken.read.problem}`)
  }
  throw notFound(`No ${source} workflow "${id}"`)
}
