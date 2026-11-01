// What Settings › Account says for the subscription status `/api/v1/me` reports.

const LABELS = {
  none: 'account.subscription.none',
  trialing: 'account.subscription.trialing',
  active: 'account.subscription.active',
  past_due: 'account.subscription.pastDue',
  paused: 'account.subscription.paused',
  canceled: 'account.subscription.canceled',
} as const

export type SubscriptionLabel = (typeof LABELS)[keyof typeof LABELS]

/** The message in the settings namespace for a status, or null for one this version does not know. */
export function subscriptionLabel(status: string): SubscriptionLabel | null {
  return Object.hasOwn(LABELS, status) ? LABELS[status as keyof typeof LABELS] : null
}
