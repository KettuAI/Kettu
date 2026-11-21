// Kettu's own skills on disk: the skills of the features that are on, together in one folder named
// for their texts, kept while an agent may still read it.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { kettuSkills, skillSetName, type GuideFlags } from './guide'

const PARTIAL = '.partial-'

/** The folder of the skills an agent gets for these features, one skill folder in it each. */
export function kettuSkillRoot(root: string, flags: GuideFlags): string {
  return path.join(root, skillSetName(kettuSkills(flags)))
}

/** The folder of each of those skills, by name, as a plugin links it. */
export function kettuSkillDirs(root: string, flags: GuideFlags): Map<string, string> {
  const set = kettuSkillRoot(root, flags)
  return new Map(kettuSkills(flags).map((skill) => [skill.name, path.join(set, skill.name)]))
}

/**
 * Writes the skills for `flags` unless they are there, whole and then moved into place so an agent
 * never reads half of them, and removes everything else in `root` but the folders in `keep`, which
 * agents were handed and may still read.
 */
export async function writeKettuSkills(
  root: string,
  flags: GuideFlags,
  keep: ReadonlySet<string>,
): Promise<void> {
  const skills = kettuSkills(flags)
  const name = skillSetName(skills)
  await mkdir(root, { recursive: true })
  for (const entry of await readdir(root)) {
    if (entry !== name && !keep.has(entry)) {
      await rm(path.join(root, entry), { recursive: true, force: true })
    }
  }
  if (await exists(path.join(root, name))) return
  const partial = path.join(root, `${PARTIAL}${randomUUID()}`)
  try {
    for (const skill of skills) {
      const dir = path.join(partial, skill.name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), skill.text)
      for (const file of skill.files) await writeFile(path.join(dir, file.name), file.text)
    }
    await rename(partial, path.join(root, name))
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
