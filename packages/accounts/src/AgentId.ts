/**
 * The stable agent id of an account-backed seat.
 *
 * Usage attribution needs to map an attempt back to the account that ran it,
 * and the run journal only carries a string. This prefix is that string's
 * contract, and it is defined once here rather than spelled out at each call
 * site.
 *
 * @since 1.0.0
 */

/** The prefix every account-backed agent id carries. @since 1.0.0 */
export const prefix = "smithers-account:"

/**
 * The agent id for a registered account label.
 *
 * @category conversions
 * @since 1.0.0
 */
export const registeredAgentId = (label: string): string => `${prefix}${label}`

/**
 * The account label behind an agent id, or `undefined` when the id names
 * something other than a registered account.
 *
 * @category conversions
 * @since 1.0.0
 */
export const registeredAgentLabel = (agentId: unknown): string | undefined => {
  if (typeof agentId !== "string" || !agentId.startsWith(prefix)) return undefined
  const label = agentId.slice(prefix.length)
  return label === "" ? undefined : label
}
