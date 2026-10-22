import { describe, expect, it } from 'vitest'
import { iconId, indexManifest } from './file-icons'

const manifest = indexManifest({
  file: 'file',
  folder: 'folder',
  folderExpanded: 'folder-open',
  fileNames: { 'package.json': 'nodejs', Dockerfile: 'docker', '.github/dependabot.yml': 'bot' },
  fileExtensions: {
    ts: 'typescript',
    'd.ts': 'typescript-def',
    'test.ts': 'test-ts',
    md: 'markdown',
  },
  folderNames: { src: 'folder-src', '.github/workflows': 'folder-workflows' },
  folderNamesExpanded: { src: 'folder-src-open' },
  light: { fileExtensions: { md: 'markdown_light' } },
})

describe('iconId', () => {
  it('prefers the file name, ignoring case', () => {
    expect(iconId(manifest, 'web/package.json', 'file')).toBe('nodejs')
    expect(iconId(manifest, 'dockerfile', 'file')).toBe('docker')
  })

  it('matches a name with its parent folder', () => {
    expect(iconId(manifest, '.github/dependabot.yml', 'file')).toBe('bot')
    expect(iconId(manifest, 'dependabot.yml', 'file')).toBe('file')
    expect(iconId(manifest, 'a/.github/workflows', 'folder')).toBe('folder-workflows')
  })

  it('tries the longest extension first', () => {
    expect(iconId(manifest, 'src/types.d.ts', 'file')).toBe('typescript-def')
    expect(iconId(manifest, 'src/app.test.ts', 'file')).toBe('test-ts')
    expect(iconId(manifest, 'src/app.ts', 'file')).toBe('typescript')
  })

  it('falls back to the defaults', () => {
    expect(iconId(manifest, 'LICENSE', 'file')).toBe('file')
    expect(iconId(manifest, 'docs', 'folder')).toBe('folder')
    expect(iconId(manifest, 'docs', 'folder', { open: true })).toBe('folder-open')
  })

  it('takes a folder icon by whether it is open', () => {
    expect(iconId(manifest, 'src', 'folder')).toBe('folder-src')
    expect(iconId(manifest, 'src', 'folder', { open: true })).toBe('folder-src-open')
  })

  it('uses the light icons in the light theme only', () => {
    expect(iconId(manifest, 'README.md', 'file', { light: true })).toBe('markdown_light')
    expect(iconId(manifest, 'README.md', 'file')).toBe('markdown')
  })
})
