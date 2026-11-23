// @ts-check
// Signs a release's update files, the daemon's install script and its packages' checksums with the
// Ed25519 release key in UPDATE_SIGNING_KEY, a PKCS#8 PEM, writing <file>.sig beside each: the
// standard base64 of the signature of the file's name, a newline and its bytes, and a newline. The
// app and the daemon take these files only with a signature under a key they have built in, so the
// release fails without the key, or when the current key would refuse a signature:
//
//   UPDATE_SIGNING_KEY="$(cat release.pem)" node tools/workflow/sign-update-files.mjs \
//     release/latest*.yml release/install.sh release/kettu-daemon-sha256sums.txt
//
// No dependencies.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message)
  process.exit(1)
}

const SIGNED_NAMES = /^(latest.*\.yml|install\.sh|kettu-daemon-sha256sums\.txt)$/

const files = process.argv.slice(2)
if (files.length === 0) fail('Name the files to sign')
const pem = process.env.UPDATE_SIGNING_KEY ?? ''
if (!pem.trim()) {
  fail('UPDATE_SIGNING_KEY is not set, and a release never ships unsigned update files')
}

/** @type {import('node:crypto').KeyObject} */
let key
try {
  key = createPrivateKey(pem)
} catch {
  fail('UPDATE_SIGNING_KEY is not a PEM private key')
}
if (key.asymmetricKeyType !== 'ed25519') fail('UPDATE_SIGNING_KEY is not an Ed25519 key')

/** @type {{ release: { current: string } }} */
const keys = JSON.parse(
  readFileSync(new URL('../../src/main/update-keys.json', import.meta.url), 'utf8'),
)
const current = createPublicKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(keys.release.current, 'base64').toString('base64url'),
  },
  format: 'jwk',
})

for (const file of files) {
  if (!SIGNED_NAMES.test(basename(file))) fail(`${file} is not a file the release signs`)
  // Signed with its name, as the app checks it, so no file passes as another's.
  const message = Buffer.concat([Buffer.from(`${basename(file)}\n`, 'utf8'), readFileSync(file)])
  const signature = sign(null, message, key)
  if (!verify(null, message, current, signature)) {
    fail(`The app's current release key does not accept the signature of ${file}`)
  }
  writeFileSync(`${file}.sig`, `${signature.toString('base64')}\n`)
  console.log(`Signed ${file}`)
}
