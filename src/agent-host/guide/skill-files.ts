// Kettu's own skills on disk: every text a skill can have, each in a folder named for that text,
// written once and kept while this version of the app uses it.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { allSkillFolders, kettuSkills, skillFolderName, type GuideFlags } from './guide'

const PARTIAL = '.partial-'

/**
 * Brings `root` in line with this version's skills: folders it no longer uses go, and each folder
 * it lacks is written whole, then moved into place, so an agent never reads half of one.
 */
export async function writeKettuSkills(root: string): Promise<void> {
  const folders = allSkillFolders()
  await mkdir(root, { recursive: true })
  const present = new Set(await readdir(root))
  for (const name of present) {
    if (!folders.has(name)) await rm(path.join(root, name), { recursive: true, force: true })
  }
  for (const [folder, skill] of folders) {
    if (present.has(folder)) continue
    const partial = path.join(root, `${PARTIAL}${randomUUID()}`)
    try {
      const dir = path.join(partial, skill.name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), skill.text)
      for (const file of skill.files) await writeFile(path.join(dir, file.name), file.text)
      await rename(partial, path.join(root, folder))
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      throw error
    }
  }
}

/** The skill roots under `root` an agent is handed for these features, each holding one skill. */
export function kettuSkillRoots(root: string, flags: GuideFlags): string[] {
  return kettuSkills(flags).map((skill) => path.join(root, skillFolderName(skill)))
}

/** The folder of a skill under one of those roots, as a plugin links it. */
export function kettuSkillDirs(root: string, flags: GuideFlags): Map<string, string> {
  return new Map(
    kettuSkills(flags).map((skill) => [
      skill.name,
      path.join(root, skillFolderName(skill), skill.name),
    ]),
  )
}
