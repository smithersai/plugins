/**
 * The provider behind a registered account.
 *
 * Subscription providers are authenticated by a per-account CLI configuration
 * directory; API providers are authenticated by a key. The split is what makes
 * a seat pool possible: two subscription accounts differ only by the directory
 * their CLI reads, so the same binary can run as either one.
 *
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * Providers authenticated by a per-account CLI configuration directory.
 *
 * @category models
 * @since 1.0.0
 */
export const subscriptionProviders = Object.freeze(
  ["claude-code", "antigravity", "codex", "kimi", "grok"] as const
)

/**
 * Providers authenticated by an API key.
 *
 * @category models
 * @since 1.0.0
 */
export const apiKeyProviders = Object.freeze(
  ["anthropic-api", "openai-api", "gemini-api", "xai-api"] as const
)

/**
 * Every provider this build recognizes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AccountProvider = Schema.Literals([...subscriptionProviders, ...apiKeyProviders])

/**
 * The decoded form of {@link AccountProvider}.
 *
 * @category models
 * @since 1.0.0
 */
export type AccountProvider = typeof AccountProvider.Type

const subscriptions: ReadonlySet<string> = new Set<string>(subscriptionProviders)
const apiKeys: ReadonlySet<string> = new Set<string>(apiKeyProviders)
const valid: ReadonlySet<string> = new Set<string>([...subscriptionProviders, ...apiKeyProviders])

/**
 * Reports whether a provider name is one this build recognizes.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isProvider = (value: unknown): value is AccountProvider =>
  typeof value === "string" && valid.has(value)

/**
 * Reports whether a provider authenticates by configuration directory.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isSubscription = (provider: AccountProvider): boolean => subscriptions.has(provider)

/**
 * Reports whether a provider authenticates by API key.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isApiKey = (provider: AccountProvider): boolean => apiKeys.has(provider)

/**
 * Every recognized provider name, for error messages that list the options.
 *
 * @category getters
 * @since 1.0.0
 */
export const names = (): ReadonlyArray<string> => [...valid]
