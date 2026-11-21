// The GitHub repositories the skills catalog reads, as the app ships them, and how one repository's
// tarball becomes its skills: each SKILL.md under the folders it lists, named by its frontmatter,
// with its license and the tools it lets the agent use without asking.

import { SKILL_NAME, type SkillTrust } from '@shared/marketplace'
import { frontmatter, frontmatterLists } from './frontmatter'
import { LocalizedError, logText } from '../localized-error'
import { folderFiles, type FolderLimits, type TarFile, type Tarball } from './tarball'

export interface SkillRepositorySpec {
  owner: string
  repo: string
  branch: string
  /** As GitHub shows the account's name. */
  publisher: string
  trust: SkillTrust
  /**
   * The folders whose SKILL.md files are skills, at any depth under them: `*` stands for any part
   * of one folder's name, and '' is the repository's root. Folders under them that start with a
   * dot are the repository's own and never read.
   */
  read: readonly string[]
  /** Folders under those to leave out, the same way, and every skill in them. */
  skip?: readonly string[]
  /** What the repository says its license is, when it holds no license file. */
  license?: string
}

/**
 * Picked on 2026-11-15 for coding agents: permissive licenses, maintained in the last month; GitHub's
 * verified domains give the trust. Each one's default branch is `main`.
 */
export const SKILL_REPOSITORIES: readonly SkillRepositorySpec[] = [
  repo('anthropics/skills', 'Anthropic', 'official', ['skills']),
  repo('obra/superpowers', 'Jesse Vincent', 'community', ['skills']),
  repo('mattpocock/skills', 'Matt Pocock', 'community', ['skills'], {
    skip: ['skills/in-progress'],
  }),
  repo('addyosmani/agent-skills', 'Addy Osmani', 'community', ['skills']),
  repo('trailofbits/skills', 'Trail of Bits', 'verified', ['plugins/*/skills']),
  // Its Figma skills are under Figma's own terms, and `.system` holds Codex's built-in ones.
  repo('openai/skills', 'OpenAI', 'verified', ['skills/.curated'], {
    skip: ['skills/.curated/figma*'],
  }),
  // Its README and frontmatter say MIT; it has no license file.
  repo('vercel-labs/agent-skills', 'Vercel Labs', 'verified', ['skills'], { license: 'MIT' }),
  repo('emilkowalski/skills', 'Emil Kowalski', 'community', ['skills']),
  repo('cloudflare/skills', 'Cloudflare', 'community', ['skills']),
  repo('supabase/agent-skills', 'Supabase', 'verified', ['skills']),
  repo('prisma/skills', 'Prisma', 'verified', ['']),
  repo('expo/skills', 'Expo', 'verified', ['plugins/*/skills']),
]

function repo(
  id: string,
  publisher: string,
  trust: SkillTrust,
  read: string[],
  more: Pick<SkillRepositorySpec, 'skip' | 'license'> = {},
): SkillRepositorySpec {
  const [owner, name] = id.split('/') as [string, string]
  return { owner, repo: name, branch: 'main', publisher, trust, read, ...more }
}

export const repositoryId = (spec: SkillRepositorySpec): string => `${spec.owner}/${spec.repo}`

export const repositoryUrl = (spec: SkillRepositorySpec): string =>
  `https://github.com/${spec.owner}/${spec.repo}`

export const SKILL_FILE = 'SKILL.md'
export const SKILL_MD_BYTES = 256 * 1024
const DESCRIPTION_CHARS = 1024
const LICENSE_CHARS = 100
const TOOLS = 64
const TOOL_CHARS = 200

/** A skill of a repository as the catalog keeps it. */
export interface CatalogEntry {
  name: string
  description: string
  /** Its folder in the repository. */
  path: string
  license: string | null
  allowedTools: string[]
}

/** Whether a folder's path is a pattern's folder or inside it; `*` stands for any part of a name. */
function within(pattern: string, folder: string): boolean {
  if (pattern === '') return true
  const want = pattern.split('/')
  const parts = folder === '' ? [] : folder.split('/')
  if (parts.length < want.length) return false
  return want.every((part, i) => globPart(part).test(parts[i]!))
}

function globPart(part: string): RegExp {
  const escaped = part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/** The folder of each skill the repository's listed folders hold, outermost first, once each. */
export function listedSkillDirs(tarball: Tarball, spec: SkillRepositorySpec): string[] {
  const dirs = tarball.files
    .map((file) => file.path)
    .filter((file) => file === SKILL_FILE || file.endsWith(`/${SKILL_FILE}`))
    .map((file) => file.slice(0, Math.max(0, file.length - SKILL_FILE.length - 1)))
    .filter((dir) =>
      spec.read.some((pattern) => {
        if (!within(pattern, dir)) return false
        const depth = pattern === '' ? 0 : pattern.split('/').length
        const below = dir === '' ? [] : dir.split('/').slice(depth)
        return !below.some((part) => part.startsWith('.'))
      }),
    )
    .filter((dir) => !(spec.skip ?? []).some((pattern) => within(pattern, dir)))
    .sort()
  // A SKILL.md inside another skill's folder is one of its files, not a skill of its own.
  return dirs.filter((dir, i) => !dirs.slice(0, i).some((outer) => dir.startsWith(`${outer}/`)))
}

/** A skill's name and description from its SKILL.md, or why it is not one Kettu keeps. */
export function skillFields(text: string, fallback: string): { name: string; description: string } {
  const fields = frontmatter(text)
  const name = (fields.name ?? fallback).trim()
  const description = (fields.description ?? '').replace(/\s+/g, ' ').trim()
  if (!SKILL_NAME.test(name)) {
    throw new LocalizedError({ key: 'marketSkills.badName', params: { name } })
  }
  if (description === '') {
    throw new LocalizedError({ key: 'marketSkills.noDescription', params: { name } })
  }
  return { name, description: description.slice(0, DESCRIPTION_CHARS) }
}

/**
 * The tools a SKILL.md's `allowed-tools` names: a YAML list, or one line split at commas and
 * spaces outside parentheses, since a rule such as `Bash(npx expo *)` holds spaces.
 */
export function allowedTools(text: string): string[] {
  const list = frontmatterLists(text)['allowed-tools']
  const line = frontmatter(text)['allowed-tools']
  const items = list ?? (line === undefined ? [] : splitTools(line))
  const out: string[] = []
  for (const item of items) {
    const tool = item
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim()
    if (tool === '' || tool.length > TOOL_CHARS || out.includes(tool)) continue
    out.push(tool)
    if (out.length === TOOLS) break
  }
  return out
}

function splitTools(line: string): string[] {
  const text = line.trim().replace(/^\[(.*)\]$/s, '$1')
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(txt|md))?$/i

/** The SPDX id of a well-known license's text; null for any other. */
export function licenseOfText(text: string): string | null {
  const head = text.slice(0, 4096)
  if (/Apache License,?\s+Version 2\.0/i.test(head)) return 'Apache-2.0'
  if (/Attribution-ShareAlike 4\.0 International/i.test(head)) return 'CC-BY-SA-4.0'
  if (/Attribution 4\.0 International/i.test(head)) return 'CC-BY-4.0'
  if (/Mozilla Public License,?\s+(Version|v\.?)\s*2\.0/i.test(head)) return 'MPL-2.0'
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(head)) return 'MIT'
  if (/\bISC License\b/i.test(head)) return 'ISC'
  if (/This is free and unencumbered software released into the public domain/i.test(head)) {
    return 'Unlicense'
  }
  if (/Redistribution and use in source and binary forms/i.test(head)) {
    return /Neither the name/i.test(head) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  }
  return null
}

/** The license file at the top of a folder's files, by their paths inside it. */
function licenseFile(files: readonly Pick<TarFile, 'path' | 'data'>[]): string | null {
  const file = files.find((item) => !item.path.includes('/') && LICENSE_FILE.test(item.path))
  if (!file) return null
  return licenseOfText(file.data.subarray(0, 4096).toString('utf8')) ?? file.path
}

/** A repository's license: its license file's, else what the list says it is. */
export function repositoryLicense(tarball: Tarball, spec: SkillRepositorySpec): string | null {
  return licenseFile(tarball.files) ?? spec.license ?? null
}

/**
 * A skill's license: what its SKILL.md says, unless that points at a license file in its folder,
 * then that file's; else the repository's.
 */
export function skillLicense(
  text: string,
  files: readonly Pick<TarFile, 'path' | 'data'>[],
  repository: string | null,
): string | null {
  const said = (frontmatter(text).license ?? '').replace(/\s+/g, ' ').trim()
  const file = licenseFile(files)
  const named = files.some(
    (item) =>
      !item.path.includes('/') &&
      LICENSE_FILE.test(item.path) &&
      said.toLowerCase().includes(item.path.toLowerCase()),
  )
  if (said !== '' && !named) return said.slice(0, LICENSE_CHARS)
  return file ?? repository
}

/** A skill of a repository read from its tarball, with its files by their paths in its folder. */
export interface RepositorySkill {
  entry: CatalogEntry
  files: TarFile[]
}

/**
 * The skills of a repository's tarball: one for each SKILL.md under its listed folders, the first
 * by path of any two with one name. What is left out comes back with the reason.
 */
export function repositorySkills(
  tarball: Tarball,
  spec: SkillRepositorySpec,
  limits: FolderLimits,
): { skills: RepositorySkill[]; left: { path: string; reason: string }[] } {
  const repository = repositoryLicense(tarball, spec)
  const skills: RepositorySkill[] = []
  const left: { path: string; reason: string }[] = []
  for (const dir of listedSkillDirs(tarball, spec)) {
    try {
      const files = folderFiles(tarball, dir, limits)
      const text = files
        .find((file) => file.path === SKILL_FILE)!
        .data.subarray(0, SKILL_MD_BYTES)
        .toString('utf8')
      const { name, description } = skillFields(text, dir.split('/').pop() || spec.repo)
      const same = skills.find((skill) => skill.entry.name === name)
      if (same) {
        throw new LocalizedError({
          key: 'marketSkills.sameName',
          params: { path: same.entry.path, name },
        })
      }
      const entry: CatalogEntry = {
        name,
        description,
        path: dir,
        license: skillLicense(text, files, repository),
        allowedTools: allowedTools(text),
      }
      skills.push({ entry, files })
    } catch (error) {
      left.push({ path: dir, reason: logText(error) })
    }
  }
  return { skills, left }
}
