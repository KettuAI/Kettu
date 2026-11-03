import assert from 'node:assert/strict'

/** Checks that opening the project menu moves nothing and that the popup fits its widest item. */
export async function checkProjectMenu(cdp, name) {
  const row = `([...document.querySelectorAll('[data-sidebar-row]')].find((button) => button.textContent.trim() === ${JSON.stringify(name)})?.parentElement)`
  const trigger = `${row}?.querySelector('[data-sidebar="menu-action"]:has(.lucide-ellipsis)')`
  const actions = async () =>
    cdp.evaluate(`(() => {
      const row = ${row}
      const bounds = (button) => {
        if (!button) return null
        const { x, y, width, height } = button.getBoundingClientRect()
        return { x, y, width, height }
      }
      return {
        more: bounds(row?.querySelector('[data-sidebar="menu-action"]:has(.lucide-ellipsis)')),
        create: bounds(row?.querySelector('[data-sidebar="menu-action"]:has(.lucide-plus)')),
      }
    })()`)
  const waitOpen = async (open) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const expanded = await cdp.evaluate(`${trigger}?.getAttribute('aria-expanded')`)
      if ((expanded === 'true') === open) return
      await new Promise((done) => setTimeout(done, 20))
    }
    throw new Error(`Project menu did not ${open ? 'open' : 'close'}`)
  }
  // What the popup would be if it were only as wide as its widest item, measured from the item's
  // own parts: an element's stretched width says nothing about how much room its text needs.
  const menuFit = `(() => {
    const popup = document.querySelector('[data-slot="dropdown-menu-content"]')
    if (!popup) return null
    const textWidth = (node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect().width
    }
    const widths = [...popup.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((item) => {
      const style = getComputedStyle(item)
      const gaps = Number.parseFloat(style.columnGap) || 0
      const parts = [...item.childNodes].filter(
        (node) => node.nodeType === Node.ELEMENT_NODE || node.textContent.trim() !== '',
      )
      const content = parts.reduce((sum, node) => sum + textWidth(node), 0)
      return (
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        content +
        gaps * Math.max(0, parts.length - 1)
      )
    })
    return {
      popup: popup.getBoundingClientRect().width,
      fit: Math.max(160, ...widths.map((width) => width + 10)),
    }
  })()`
  const before = await actions()
  assert.ok(before.more, 'The project More button must exist')
  assert.ok(before.create, 'The project New session button must exist')
  const box = await cdp.evaluate(`(${trigger}).getBoundingClientRect().toJSON()`)
  assert.ok(box.width > 0, 'The project More button must be laid out')
  await cdp.evaluate(`(${trigger}).click()`)
  try {
    await waitOpen(true)
    const opened = await actions()
    assert.deepEqual(opened.more, before.more, 'Opening the menu must not move its trigger')
    assert.deepEqual(
      opened.create,
      before.create,
      'Opening the menu must keep New session in place',
    )
    const width = await cdp.evaluate(menuFit)
    assert.ok(width, 'The project menu must be open')
    assert.ok(
      width.popup <= width.fit + 12,
      `The project menu must fit its widest item: ${width.popup}px of ${width.fit}px`,
    )
  } finally {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', windowsVirtualKeyCode: 27 })
    }
  }
  await waitOpen(false)
  assert.deepEqual(await actions(), before, 'Closing the menu must keep both actions in place')
}
