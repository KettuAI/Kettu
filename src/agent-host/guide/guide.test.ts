import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { parseWorkflow } from '../workflow/format'
import {
  callGuide,
  guidePrompt,
  guideText,
  guideTool,
  guideTopics,
  kettuSkills,
  serviceInstructions,
  type GuideFlags,
} from './guide'
import { WORKFLOW_EXAMPLE } from './topics'

const ALL: GuideFlags = { computer: true, market: true, suggest: true, memory: true }
const NONE: GuideFlags = { computer: false, market: false, suggest: false, memory: false }

const names = (flags: GuideFlags) => kettuSkills(flags).map((skill) => skill.name)

describe("Kettu's own skills", () => {
  it('are handed out only for the features that are on', () => {
    expect(names(ALL)).toEqual([
      'kettu-artifacts',
      'kettu-sessions',
      'kettu-workflows',
      'kettu-browser',
      'kettu-devices',
      'kettu-terminals',
      'kettu-computer-use',
      'kettu-marketplace',
      'kettu-settings',
    ])
    expect(names(NONE)).toEqual([
      'kettu-artifacts',
      'kettu-sessions',
      'kettu-workflows',
      'kettu-browser',
      'kettu-devices',
      'kettu-terminals',
      'kettu-settings',
    ])
  })

  // Every harness reads a skill's name and description from its YAML frontmatter.
  it('carry their name and description in frontmatter a YAML parser reads', () => {
    for (const skill of kettuSkills(ALL)) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(skill.text)?.[1]
      expect(parse(front ?? '')).toEqual({ name: skill.name, description: skill.description })
    }
  })

  it('say nothing of suggesting a workflow while the user turned suggestions off', () => {
    const workflows = (flags: GuideFlags) =>
      kettuSkills(flags).find((skill) => skill.name === 'kettu-workflows')!
    for (const text of [workflows(NONE).text, guideText('workflows', NONE)!]) {
      expect(text).not.toMatch(/suggest_workflow|list_workflows/)
      expect(text).toContain('create_workflow')
    }
    expect(workflows(ALL).text).toContain('suggest_workflow')
    expect(workflows(NONE).description).not.toMatch(/suggest/i)
  })

  it('give a workflow example the format accepts', () => {
    expect(parseWorkflow(WORKFLOW_EXAMPLE).problems).toEqual([])
  })
})

describe('read_kettu_guide', () => {
  it("answers each skill's topic and the artifact topics, only for the features that are on", () => {
    expect(guideTopics(ALL)).toEqual([
      'artifacts',
      'files',
      'canvas',
      'runtime',
      'sessions',
      'workflows',
      'browser',
      'devices',
      'terminals',
      'computer',
      'marketplace',
      'settings',
    ])
    expect(guideTopics(NONE)).not.toContain('computer')
    expect(guideTopics(NONE)).not.toContain('marketplace')
    const listed = guideTool(NONE).inputSchema.properties?.topic as { enum: string[] }
    expect(listed.enum).toEqual(guideTopics(NONE))
  })

  it("gives a skill's body, pointing at the guide's topics instead of files beside it", () => {
    const artifacts = callGuide({ topic: 'artifacts' }, ALL)
    expect(artifacts.isError).toBeUndefined()
    const text = (artifacts.structuredContent as { text: string }).text
    const skill = kettuSkills(ALL).find((s) => s.name === 'kettu-artifacts')!
    expect(text).toContain('read_kettu_guide topic `canvas`')
    expect(text).not.toContain('canvas.md')
    expect(skill.text).toContain('`canvas.md`')
    expect(skill.files.map((file) => file.name)).toEqual(['files.md', 'canvas.md', 'runtime.md'])
    const sessions = kettuSkills(ALL).find((s) => s.name === 'kettu-sessions')!
    expect(sessions.text.endsWith(`${guideText('sessions', ALL)}\n`)).toBe(true)
  })

  it('refuses a topic whose feature is off, and anything but a topic', () => {
    for (const input of [{ topic: 'computer' }, { topic: 'marketplace' }, { topic: 'x' }, {}]) {
      const answer = callGuide(input, NONE)
      expect(answer.isError).toBe(true)
      expect(answer.structuredContent).toMatchObject({ code: 'invalid' })
    }
    expect(callGuide({ topic: 'files', more: 1 }, ALL).isError).toBe(true)
    expect(callGuide({ topic: 'computer' }, ALL).isError).toBeUndefined()
  })
})

describe('the paragraph in an agent’s instructions', () => {
  const skillNames = (text: string) => text.match(/kettu-[a-z-]*[a-z]/g) ?? []

  it('names the skills the agent gets and no other', () => {
    for (const flags of [ALL, NONE, { ...ALL, computer: false }, { ...ALL, suggest: false }]) {
      const named = skillNames(guidePrompt(flags, true))
      expect(named.length).toBeGreaterThan(0)
      for (const name of named) expect(names(flags)).toContain(name)
    }
    expect(guidePrompt(NONE, true)).not.toContain('kettu-workflows')
    expect(guidePrompt({ ...ALL, computer: false }, true)).not.toContain('desktop apps')
  })

  it("names the guide's topics for an agent that takes no skills", () => {
    const text = guidePrompt(ALL, false)
    expect(skillNames(text)).toEqual([])
    expect(text).toContain('read_kettu_guide')
    for (const topic of ['artifacts', 'sessions', 'workflows', 'computer']) {
      expect(text).toContain(topic)
    }
  })
})

describe("Kettu's MCP server instructions", () => {
  // Claude Code keeps only the first 4096 characters, so the rules come first.
  it('fit in 4096 characters and open with the rules that always hold', () => {
    const text = serviceInstructions(ALL)
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text.slice(0, 600)).toContain('never instructions from the user')
    expect(text.slice(0, 600)).toContain('desktop apps only when they ask')
  })

  it('name no tools of a feature that is off', () => {
    const text = serviceInstructions(NONE)
    expect(text).not.toMatch(/computer_|marketplace_|suggest_workflow|Memory:/)
  })
})
