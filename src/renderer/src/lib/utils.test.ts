import { describe, expect, it } from 'vitest'
import { build } from 'cn/build'
// shadcn/ui components import the package; the build points it at lib/utils.
import { cn } from 'cn'

describe('cn', () => {
  it('merges the theme text sizes as sizes, not colors', () => {
    expect(cn('text-primary-foreground', 'text-ui')).toBe('text-primary-foreground text-ui')
    expect(cn('text-ui', 'text-muted-foreground')).toBe('text-ui text-muted-foreground')
    expect(cn('text-sm', 'text-ui')).toBe('text-ui')
  })

  it("merges the palette's own names as colors, not sizes", () => {
    expect(cn('text-xs', 'text-tertiary')).toBe('text-xs text-tertiary')
    expect(cn('text-muted-foreground', 'text-secondary')).toBe('text-secondary')
    expect(cn('bg-sidebar-accent', 'bg-selected')).toBe('bg-selected')
    expect(cn('border-border', 'border-subtle')).toBe('border-subtle')
  })

  it('merges the theme shadows as shadows, not colors', () => {
    expect(cn('shadow-sm', 'shadow-card')).toBe('shadow-card')
    expect(cn('shadow-card', 'shadow-black/10')).toBe('shadow-card shadow-black/10')
  })

  it('uses tables compiled from the current theme', async () => {
    // Same options as the cn plugin in electron.vite.config.ts; a stale file is rewritten here.
    const { changed } = await build({
      cwd: 'src/renderer',
      full: true,
      out: 'src/lib/cn-tables.ts',
    })
    expect(changed, 'cn-tables.ts was stale: commit the regenerated file').toBe(false)
  })
})
