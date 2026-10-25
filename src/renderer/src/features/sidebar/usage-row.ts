import { usd } from '@renderer/lib/format'

/** The Usage row's end for today's cost: "$4.20", or null while it is zero or unpriced. */
export function costText(cost: number | null): string | null {
  return cost !== null && cost > 0 ? usd(cost) : null
}
