import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const builderRequire = createRequire(
  createRequire(import.meta.url).resolve('electron-builder/package.json'),
)
const packagerRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const notarizeRequire = createRequire(packagerRequire.resolve('@electron/notarize'))
const { notarize } = packagerRequire('@electron/notarize') as {
  notarize: (options: { appPath: string }) => Promise<void>
}
const signatures = notarizeRequire('./check-signature') as {
  checkSignatures: () => Promise<void>
}
const notarytool = notarizeRequire('./notarytool') as {
  isNotaryToolAvailable: () => Promise<boolean>
  notarizeAndWaitForNotaryTool: () => Promise<void>
}
const stapler = notarizeRequire('./staple') as {
  stapleApp: () => Promise<void>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(signatures, 'checkSignatures').mockResolvedValue()
  vi.spyOn(notarytool, 'isNotaryToolAvailable').mockResolvedValue(true)
  vi.spyOn(notarytool, 'notarizeAndWaitForNotaryTool').mockResolvedValue()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the installed notarizer', () => {
  it('retries stapling after a ticket failure without signing or submitting again', async () => {
    const staple = vi
      .spyOn(stapler, 'stapleApp')
      .mockRejectedValueOnce(new Error('Failed to staple your application with code: 68'))
      .mockRejectedValueOnce(new Error('NSURLErrorDomain Code=-1005'))
      .mockResolvedValue()
    const result = notarize({ appPath: '/unused/Kettu.app' }).then(
      () => null,
      (error: unknown) => error,
    )
    await vi.runAllTimersAsync()
    expect(await result).toBeNull()
    expect(staple).toHaveBeenCalledTimes(3)
    expect(signatures.checkSignatures).toHaveBeenCalledTimes(1)
    expect(notarytool.notarizeAndWaitForNotaryTool).toHaveBeenCalledTimes(1)
  })

  it('still fails with the last error when every stapling attempt fails', async () => {
    const failure = new Error('Failed to staple your application with code: 68')
    const staple = vi.spyOn(stapler, 'stapleApp').mockRejectedValue(failure)
    const result = notarize({ appPath: '/unused/Kettu.app' }).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await result).toBe(failure)
    expect(staple).toHaveBeenCalledTimes(4)
    expect(notarytool.notarizeAndWaitForNotaryTool).toHaveBeenCalledTimes(1)
  })

  it('fails immediately when the signature is invalid', async () => {
    const failure = new Error('Invalid signature')
    vi.mocked(signatures.checkSignatures).mockRejectedValue(failure)
    const staple = vi.spyOn(stapler, 'stapleApp')
    await expect(notarize({ appPath: '/unused/Kettu.app' })).rejects.toBe(failure)
    expect(staple).not.toHaveBeenCalled()
    expect(notarytool.notarizeAndWaitForNotaryTool).not.toHaveBeenCalled()
  })
})
