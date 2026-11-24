import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PluginResource } from '@shared/plugins'
import { tempFolder } from '../testing/temp'
import { PluginTemplates } from './plugin-templates'

/** A folder-form template: its resource names `template.json`, as the package reader does. */
async function folderTemplate(
  root: string,
  name: string,
  description: Record<string, unknown> | string,
  files: Record<string, string> = {},
): Promise<PluginResource> {
  const folder = path.join(root, 'sh.kettu', 'templates', name)
  await mkdir(folder, { recursive: true })
  const file = path.join(folder, 'template.json')
  await writeFile(file, typeof description === 'string' ? description : JSON.stringify(description))
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, relative)), { recursive: true })
    await writeFile(path.join(folder, relative), text)
  }
  return {
    name,
    description: '',
    path: `sh.kettu/templates/${name}/template.json`,
    pluginId: 'p000000000001',
    pluginName: 'acme',
    plugin: 'Acme',
    file,
  }
}

function templates(resources: PluginResource[]) {
  const log = vi.fn()
  return { reader: new PluginTemplates({ resources: async () => resources, log }), log }
}

it('reads a template and its starter files, and a description with no files', async () => {
  const root = await tempFolder('kettu-templates-')
  const weekly = await folderTemplate(
    root,
    'weekly',
    { type: 'document', guidance: ' Go. ' },
    {
      'document.md': '# Week\n',
      'images/logo.png': 'png',
    },
  )
  const alone = path.join(root, 'sh.kettu', 'templates', 'deck.json')
  await writeFile(alone, JSON.stringify({ type: 'slides' }))
  const { reader } = templates([
    { ...weekly, title: 'Weekly', description: 'A report' },
    {
      name: 'deck',
      description: 'A deck',
      path: 'sh.kettu/templates/deck.json',
      pluginId: 'p000000000001',
      pluginName: 'acme',
      plugin: 'Acme',
      file: alone,
    },
  ])
  const list = await reader.list()
  expect(list.map((template) => template.id)).toEqual(['acme:deck', 'acme:weekly'])
  const [deck, week] = list
  expect(deck).toMatchObject({ type: 'slides', files: [], folder: null })
  expect(week).toMatchObject({
    title: 'Weekly',
    summary: 'A report',
    guidance: 'Go.',
    files: [
      { path: 'document.md', size: 7 },
      { path: 'images/logo.png', size: 3 },
    ],
  })
  expect((await reader.starters(week!)).map((file) => [file.path, file.data.toString()])).toEqual([
    ['document.md', '# Week\n'],
    ['images/logo.png', 'png'],
  ])
})

it('refuses a template that adds code, links out of its folder, or is not a plain description', async () => {
  const root = await tempFolder('kettu-templates-')
  const outside = path.join(root, 'secret.md')
  await writeFile(outside, 'secret')
  const resources = [
    await folderTemplate(root, 'code', { type: 'document' }, { 'document.md': '#', 'x.js': '1' }),
    await folderTemplate(root, 'html', { type: 'document' }, { 'index.html': '<p>' }),
    await folderTemplate(root, 'deep', { type: 'document' }, { 'notes/more.md': 'a' }),
    await folderTemplate(root, 'mine', { type: 'viewer' }, { 'document.md': '#' }),
    await folderTemplate(root, 'junk', 'not json'),
    await folderTemplate(root, 'long', { type: 'document', guidance: 'x'.repeat(9_000) }),
    await folderTemplate(root, 'link', { type: 'document' }),
    await folderTemplate(root, 'fine', { type: 'document' }, { 'document.md': '#' }),
  ]
  const link = resources.find((resource) => resource.name === 'link')!
  await symlink(outside, path.join(path.dirname(link.file), 'document.md'))
  const { reader, log } = templates(resources)
  expect((await reader.list()).map((template) => template.id)).toEqual(['acme:fine'])
  const told = log.mock.calls.map((call) => String(call[1]))
  expect(told.some((line) => line.includes('acme:code') && line.includes('adds no code'))).toBe(
    true,
  )
  expect(told.some((line) => line.includes('acme:link') && line.includes('is a link'))).toBe(true)
  expect(told.some((line) => line.includes('acme:mine') && line.includes('its type must be'))).toBe(
    true,
  )
  // Each refusal is logged once however often the list is read.
  const before = log.mock.calls.length
  await reader.list()
  expect(log.mock.calls.length).toBe(before)
})

it('does not read a starter file that became a link after the template was listed', async () => {
  const root = await tempFolder('kettu-templates-')
  const outside = path.join(root, 'secret.md')
  await writeFile(outside, 'secret')
  const resource = await folderTemplate(root, 'later', { type: 'document' }, { 'document.md': '#' })
  const { reader } = templates([resource])
  const [template] = await reader.list()
  const file = path.join(path.dirname(resource.file), 'document.md')
  await rm(file)
  await symlink(outside, file)
  await expect(reader.starters(template!)).rejects.toThrow(/changed since the template was read/)
})
