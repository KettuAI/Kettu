import { describe, expect, it } from 'vitest'
import { subscriptionLabel } from './subscription-label'

describe('subscriptionLabel', () => {
  it('has words for every status the account service names', () => {
    expect(subscriptionLabel('none')).toBe('account.subscription.none')
    expect(subscriptionLabel('trialing')).toBe('account.subscription.trialing')
    expect(subscriptionLabel('active')).toBe('account.subscription.active')
    expect(subscriptionLabel('past_due')).toBe('account.subscription.pastDue')
    expect(subscriptionLabel('paused')).toBe('account.subscription.paused')
    expect(subscriptionLabel('canceled')).toBe('account.subscription.canceled')
  })

  it('leaves a status this version does not know to be shown as it is', () => {
    expect(subscriptionLabel('suspended')).toBeNull()
    expect(subscriptionLabel('toString')).toBeNull()
  })
})
