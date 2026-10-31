import { describe, expect, it } from 'vitest'
import { parseModel } from './system-model'

describe('parseModel', () => {
  it("takes the model's name from what each system prints", () => {
    const profile = JSON.stringify({
      SPHardwareDataType: [{ machine_model: 'MacBookPro18,3', machine_name: 'MacBook Pro' }],
    })
    expect(parseModel('darwin', profile)).toBe('MacBook Pro')
    const reg =
      '\r\nHKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS\r\n    SystemProductName    REG_SZ    ThinkPad X1 Carbon Gen 11\r\n\r\n'
    expect(parseModel('win32', reg)).toBe('ThinkPad X1 Carbon Gen 11')
    expect(parseModel('linux', 'OptiPlex 7090\n')).toBe('OptiPlex 7090')
  })

  it('is empty when the system names none, and never longer than a model may be', () => {
    expect(parseModel('darwin', 'not json')).toBe('')
    expect(parseModel('darwin', '{}')).toBe('')
    expect(parseModel('win32', '')).toBe('')
    expect(parseModel('linux', `${'x'.repeat(80)}\u0007\n`)).toBe('x'.repeat(64))
  })
})
