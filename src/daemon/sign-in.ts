// The daemon's own requests to the account service, with the sign-in `kettu login` keeps. Every
// refresh replaces the refresh token, and a second use of an old one makes the service end the
// sign-in, so the token is read from the file anew and refreshed one at a time.

import type { ReportSubmitFailure } from '@shared/report'
import {
  AccountServiceError,
  DAEMON_CLIENT,
  submitFailure,
  type AccountApi,
  type ReportUpload,
} from '../main/account/service'
import {
  openToken,
  readAccount,
  removeAccount,
  sealToken,
  writeAccount,
} from '../main/account/store'
import type { IdentityCipher } from '../main/remote-identity'

class NotSignedIn extends Error {}

export class DaemonSignIn {
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string> | null = null

  constructor(
    private readonly api: AccountApi,
    private readonly file: string,
    private readonly cipher: IdentityCipher,
    private readonly warn: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async signedIn(): Promise<boolean> {
    return (await readAccount(this.file, this.warn).catch(() => null)) !== null
  }

  /** Submits a problem report: its id, or why not. */
  async submitReport(
    upload: ReportUpload,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: ReportSubmitFailure }> {
    try {
      const token = await this.token(null)
      try {
        return { ok: true, id: await this.api.submitReport(token, upload) }
      } catch (error) {
        // Reports name a token the service does not take `unauthorized`; a fresh one may do.
        if (!(error instanceof AccountServiceError) || error.code !== 'unauthorized') throw error
        return { ok: true, id: await this.api.submitReport(await this.token(token), upload) }
      }
    } catch (error) {
      if (error instanceof NotSignedIn) return { ok: false, reason: 'signed_out' }
      if (error instanceof AccountServiceError && error.code === 'invalid_grant') {
        // The service ended this sign-in, so it is forgotten here too, as the desktop app does.
        this.access = null
        await removeAccount(this.file).catch(() => undefined)
        return { ok: false, reason: 'signed_out' }
      }
      return { ok: false, reason: submitFailure(error) }
    }
  }

  private token(refused: string | null): Promise<string> {
    const access = this.access
    if (access && access.token !== refused && access.expiresAt > this.now()) {
      return Promise.resolve(access.token)
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    const stored = await readAccount(this.file, this.warn)
    if (!stored) throw new NotSignedIn()
    const tokens = await this.api.refresh(DAEMON_CLIENT, await openToken(stored, this.cipher))
    await writeAccount(this.file, {
      ...stored,
      ...(await sealToken(tokens.refreshToken, this.cipher)),
    })
    this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
    return tokens.accessToken
  }
}
