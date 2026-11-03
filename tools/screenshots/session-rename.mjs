import assert from 'node:assert/strict'

/** Checks that inline renaming fits a narrow sidebar without clipping its keyboard hints. */
export async function checkSessionRename(cdp, title) {
  const row = `[...document.querySelectorAll('[data-sidebar-row]')].find((row) => row.textContent.includes(${JSON.stringify(title)}))`
  const sidebar = `document.querySelector('[data-sidebar="content"]')`
  const originalWidth = await cdp.evaluate(`${sidebar}.parentElement.style.width`)
  const press = async (key, code) => {
    await cdp.evaluate(`${sidebar}.querySelector('input')?.focus()`)
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: code })
    }
  }
  try {
    await cdp.evaluate(`(${row}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await cdp.evaluate(`!!${sidebar}.querySelector('input')`)) break
      await new Promise((done) => setTimeout(done, 20))
    }
    assert.ok(await cdp.evaluate(`!!${sidebar}.querySelector('input')`), 'Rename must open')
    await cdp.evaluate(`${sidebar}.querySelector('input').select()`)
    await cdp.send('Input.insertText', {
      text: 'A long session title that must stay inside the editor without widening the sidebar',
    })
    for (const width of [200, 240, 336]) {
      const layout = await cdp.evaluate(`(() => {
        const sidebar = ${sidebar}
        sidebar.parentElement.style.width = '${width}px'
        sidebar.scrollLeft = 0
        const input = sidebar.querySelector('input')
        const hints = [...sidebar.querySelectorAll('[aria-hidden="true"]')].find(
          (element) => element.querySelector('[data-slot="kbd"]'),
        )
        const bounds = sidebar.getBoundingClientRect()
        const items = [...hints.children].map((item) => {
          const box = item.getBoundingClientRect()
          return { left: box.left, right: box.right, width: item.clientWidth, scroll: item.scrollWidth }
        })
        sidebar.scrollLeft = 100
        return {
          width: sidebar.clientWidth,
          scroll: sidebar.scrollWidth,
          offset: sidebar.scrollLeft,
          left: bounds.left,
          right: bounds.right,
          input: input.getBoundingClientRect().toJSON(),
          items,
        }
      })()`)
      assert.equal(layout.width, width, 'The sidebar must use the requested width')
      assert.equal(layout.scroll, layout.width, `Renaming must not overflow at ${width}px`)
      assert.equal(layout.offset, 0, 'The session list must not scroll horizontally')
      assert.ok(layout.input.left >= layout.left && layout.input.right <= layout.right)
      assert.equal(layout.items.length, 3, 'All three keyboard hints must remain visible')
      for (const item of layout.items) {
        assert.ok(item.left >= layout.left && item.right <= layout.right, 'Each hint must fit')
        assert.ok(item.scroll <= item.width + 1, 'A keyboard hint must not clip its label')
      }
    }
    await press('Escape', 27)
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await cdp.evaluate(`!!${sidebar}.querySelector('input')`))) break
      await new Promise((done) => setTimeout(done, 20))
    }
    assert.ok(await cdp.evaluate(`!!(${row})`), 'Cancel must preserve the session title')
  } finally {
    if (await cdp.evaluate(`!!${sidebar}.querySelector('input')`)) await press('Escape', 27)
    await cdp.evaluate(`(() => {
      const sidebar = ${sidebar}
      sidebar.parentElement.style.width = ${JSON.stringify(originalWidth)}
      sidebar.scrollLeft = 0
    })()`)
  }
}
