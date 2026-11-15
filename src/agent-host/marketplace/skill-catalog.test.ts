import { describe, expect, it } from 'vitest'
import {
  allowedTools,
  listedSkillDirs,
  repositorySkills,
  skillLicense,
  type SkillRepositorySpec,
} from './skill-catalog'
import { checkedEntries } from './tarball'

const LIMITS = { files: 100, bytes: 1024 * 1024 }
const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person'
const APACHE =
  '                                 Apache License\n                           Version 2.0, January 2004'

function spec(over: Partial<SkillRepositorySpec>): SkillRepositorySpec {
  return {
    owner: 'o',
    repo: 'r',
    branch: 'main',
    publisher: 'O',
    trust: 'community',
    read: ['skills'],
    ...over,
  }
}

function skillMd(name: string | null, more = ''): string {
  return `---\n${name === null ? '' : `name: ${name}\n`}description: Does ${name ?? 'it'}.\n${more}---\n# Body\n`
}

/** A repository's archive from its files, by their paths inside it. */
function repository(files: Record<string, string>) {
  return checkedEntries(
    Object.entries(files).map(([file, data]) => ({
      path: `r-main/${file}`,
      type: 'file',
      data: Buffer.from(data),
    })),
    null,
  )
}

describe('listedSkillDirs', () => {
  it('reads a hidden listed folder and leaves out a sibling and the skipped names', () => {
    const tar = repository({
      'skills/.curated/playwright/SKILL.md': skillMd('playwright'),
      'skills/.curated/figma-use/SKILL.md': skillMd('figma-use'),
      'skills/.curated/figma/SKILL.md': skillMd('figma'),
      'skills/.system/skill-installer/SKILL.md': skillMd('skill-installer'),
    })
    const openai = spec({ read: ['skills/.curated'], skip: ['skills/.curated/figma*'] })
    expect(listedSkillDirs(tar, openai)).toEqual(['skills/.curated/playwright'])
  })

  it('reads the root without the repository’s own hidden folders', () => {
    const tar = repository({
      'prisma-cli/SKILL.md': skillMd('prisma-cli'),
      'prisma-orm-setup/SKILL.md': skillMd('prisma-orm-setup'),
      '.claude/skills/eval/SKILL.md': skillMd('eval'),
      '.github/workflows/ci.yml': 'on: push',
      'README.md': '# Skills',
    })
    expect(listedSkillDirs(tar, spec({ read: [''] }))).toEqual(['prisma-cli', 'prisma-orm-setup'])
  })

  it('reads skills under plugin and category folders, outermost only, skipping a folder', () => {
    const tar = repository({
      'plugins/expo/skills/expo-router/SKILL.md': skillMd('expo-router'),
      'plugins/expo/skills/expo-router/templates/SKILL.md': skillMd('template'),
      'plugins/expo-experiments/skills/migrate/SKILL.md': skillMd('migrate'),
      'plugins/kit/tests/fixtures/skills/review/SKILL.md': skillMd('review'),
      '.claude/skills/expo-skill-eval/SKILL.md': skillMd('expo-skill-eval'),
    })
    expect(listedSkillDirs(tar, spec({ read: ['plugins/*/skills'] }))).toEqual([
      'plugins/expo-experiments/skills/migrate',
      'plugins/expo/skills/expo-router',
    ])
    const pocock = repository({
      'skills/engineering/tdd/SKILL.md': skillMd('tdd'),
      'skills/productivity/grill-me/SKILL.md': skillMd('grill-me'),
      'skills/in-progress/draft/SKILL.md': skillMd('draft'),
    })
    expect(listedSkillDirs(pocock, spec({ skip: ['skills/in-progress'] }))).toEqual([
      'skills/engineering/tdd',
      'skills/productivity/grill-me',
    ])
  })
})

describe('repositorySkills', () => {
  it('names each skill by its frontmatter, keeps the first of one name and says what it left', () => {
    const tar = repository({
      'skills/composition-patterns/SKILL.md': skillMd('vercel-composition-patterns'),
      'skills/composition-patterns/rules/a.md': 'rule',
      'skills/composition-patterns.zip': 'PK',
      'skills/plain/SKILL.md': skillMd(null),
      'skills/twin/SKILL.md': skillMd('plain'),
      'skills/Bad_Name/SKILL.md': skillMd('Bad_Name'),
      'skills/quiet/SKILL.md': '---\nname: quiet\n---\n',
    })
    const { skills, left } = repositorySkills(tar, spec({}), LIMITS)
    expect(skills.map((skill) => [skill.entry.name, skill.entry.path])).toEqual([
      ['vercel-composition-patterns', 'skills/composition-patterns'],
      ['plain', 'skills/plain'],
    ])
    expect(skills[0]!.files.map((file) => file.path).sort()).toEqual(['SKILL.md', 'rules/a.md'])
    expect(left.map((item) => item.path)).toEqual([
      'skills/Bad_Name',
      'skills/quiet',
      'skills/twin',
    ])
  })

  it('takes a skill’s own license, its folder’s file, else the repository’s', () => {
    const tar = repository({
      LICENSE: MIT,
      'skills/own/SKILL.md': skillMd('own', 'license: CC-BY-4.0\n'),
      'skills/file/SKILL.md': skillMd('file', 'license: Complete terms in LICENSE.txt\n'),
      'skills/file/LICENSE.txt': APACHE,
      'skills/odd/SKILL.md': skillMd('odd'),
      'skills/odd/LICENSE.TXT': 'Use of these files is governed by our own terms.',
      'skills/bare/SKILL.md': skillMd('bare'),
    })
    const licenses = repositorySkills(tar, spec({}), LIMITS).skills.map((skill) => [
      skill.entry.name,
      skill.entry.license,
    ])
    expect(licenses).toEqual([
      ['bare', 'MIT'],
      ['file', 'Apache-2.0'],
      ['odd', 'LICENSE.TXT'],
      ['own', 'CC-BY-4.0'],
    ])
    const none = repository({ 'skills/bare/SKILL.md': skillMd('bare') })
    expect(repositorySkills(none, spec({ license: 'MIT' }), LIMITS).skills[0]!.entry.license).toBe(
      'MIT',
    )
    expect(skillLicense(skillMd('x'), [], null)).toBeNull()
  })
})

describe('allowedTools', () => {
  it('reads a list, a spaced line and a comma line with spaces inside rules', () => {
    expect(allowedTools(skillMd('a', 'allowed-tools: Read Grep Glob Bash\n'))).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Bash',
    ])
    expect(
      allowedTools(skillMd('b', 'allowed-tools: "Bash(npx expo *), Bash(eas *), Read,Read"\n')),
    ).toEqual(['Bash(npx expo *)', 'Bash(eas *)', 'Read'])
    expect(allowedTools(skillMd('c', 'allowed-tools:\n  - Bash\n  - "Read"\n- Write\n'))).toEqual([
      'Bash',
      'Read',
      'Write',
    ])
    expect(allowedTools(skillMd('d', 'allowed-tools: [Read, Edit]\n'))).toEqual(['Read', 'Edit'])
    expect(allowedTools(skillMd('e'))).toEqual([])
  })
})
