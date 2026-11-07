// Where the hosted web client signs in and reaches its hosts: the project's services, or the copies
// a development build was pointed at when it was built.

import { ACCOUNT_URL } from '@shared/account-api'
import { RELAY_URL } from '@shared/remote/relay'

export const HOSTED = __KETTU_HOSTED__

export const accountUrl = (__KETTU_ACCOUNT_URL__ || ACCOUNT_URL).replace(/\/+$/, '')

export const relayUrl = __KETTU_RELAY_URL__ || RELAY_URL
