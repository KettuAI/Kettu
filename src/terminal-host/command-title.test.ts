import { describe, expect, it } from 'vitest'
import { commandTitle, typedTitle } from './command-title'

describe("a terminal's title from its command line", () => {
  it('names a script an interpreter runs by its path, as a package manager does', () => {
    expect(commandTitle(['node', '/opt/homebrew/bin/pnpm', 'dev'])).toBe('pnpm dev')
    expect(commandTitle(['node', '/usr/lib/node_modules/corepack/dist/pnpm.cjs', 'test'])).toBe(
      'pnpm test',
    )
    expect(commandTitle(['/usr/bin/python3', '/usr/local/bin/http-server', '-p', '80'])).toBe(
      'http-server -p 80',
    )
  })

  it('keeps an interpreter given a bare script or its own flags', () => {
    expect(commandTitle(['python', 'manage.py', 'runserver'])).toBe('python manage.py runserver')
    expect(commandTitle(['node', '--watch', 'server.js'])).toBe('node --watch server.js')
  })

  it('shortens paths to their last part and drops a login shell dash', () => {
    expect(commandTitle(['/usr/bin/vim', '/Users/me/app/src/main.ts'])).toBe('vim main.ts')
    expect(commandTitle(['-zsh'])).toBe('zsh')
    expect(commandTitle(['git', 'log', '--oneline'])).toBe('git log --oneline')
  })

  it('cuts a long command at the length of a name', () => {
    const title = commandTitle(['ssh', 'deploy@a-very-long-host-name.example.internal.company.com'])
    expect(title).toHaveLength(40)
    expect(title?.endsWith('…')).toBe(true)
    expect(commandTitle([])).toBeNull()
  })

  it("takes a typed command's first line", () => {
    expect(typedTitle('  pnpm dev  ')).toBe('pnpm dev')
    expect(typedTitle('cd web\npnpm build')).toBe('cd web')
  })
})
