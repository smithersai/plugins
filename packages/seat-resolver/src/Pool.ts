/**
 * Choosing which registered account runs the next attempt.
 *
 * The policy is the 0.x fallback pool's, ported whole: order the accounts a
 * provider set matches by measured headroom, break ties with a seeded shuffle
 * so one run's order is stable across re-renders while different runs spread
 * differently, and put accounts a provider has already blocked last with the
 * soonest reset first.
 *
 * Pure. The caller supplies accounts, quota state, usage reports, and the
 * clock, so an ordering is reproducible in a test.
 *
 * @since 1.0.0
 */
import type { Account } from "@smthrs-plugins/accounts/Account"
import type { QuotaState } from "@smthrs-plugins/usage/QuotaState"
import { Selection } from "@smthrs-plugins/usage"
import type { UsageReport } from "@smthrs-plugins/usage/UsageReport"

/**
 * The providers a pool draws from when the caller names none.
 *
 * Claude Code and Codex are the default because they are the two subscription
 * CLIs an operator actually registers several of.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultProviders: ReadonlyArray<Account["provider"]> = Object.freeze([
  "claude-code",
  "codex"
])

/**
 * A deterministic pseudo-random source, so a seeded pool is reproducible.
 *
 * @category constructors
 * @since 1.0.0
 */
export const seededRandom = (seed: string | number): () => number => {
  const text = String(seed)
  let state = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index)
    state = Math.imul(state, 0x01000193) >>> 0
  }
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

const shuffled = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const left = copy[index]
    const right = copy[swap]
    if (left !== undefined && right !== undefined) {
      copy[index] = right
      copy[swap] = left
    }
  }
  return copy
}

/**
 * How a pool is ordered.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Providers to draw from. Defaults to {@link defaultProviders}. */
  readonly providers?: ReadonlyArray<Account["provider"]> | "all" | undefined
  /** Live quota blocks, from `@smthrs-plugins/usage` `QuotaStore.read`. */
  readonly quota?: QuotaState["entries"] | undefined
  /** Cached usage reports keyed by account label. */
  readonly reports?: Readonly<Record<string, UsageReport>> | undefined
  /** Seeds the tie-break shuffle. A run passes its run id. */
  readonly seed?: string | number | undefined
  /** Replaces the random source outright. */
  readonly random?: (() => number) | undefined
  /** Set to false to keep registration order as the tie-break. */
  readonly shuffle?: boolean | undefined
  /** The model each provider's accounts are judged against. */
  readonly models?: Readonly<Partial<Record<Account["provider"], string>>> | undefined
  readonly nowMs?: number | undefined
}

/**
 * One rung of the pool.
 *
 * A rung carries the block that made it unusable rather than being dropped:
 * the chain outlives the call that built it, so a caller re-checks
 * `blockedUntilMs` against the clock and uses the account once its reset has
 * passed. Dropping it instead would retire the account for the whole process.
 *
 * @category models
 * @since 1.0.0
 */
export interface Rung {
  readonly account: Account
  /** The model this rung would run, if the caller named one. */
  readonly model?: string | undefined
  /** Epoch milliseconds until which a provider has blocked this account. */
  readonly blockedUntilMs?: number | undefined
}

/**
 * Orders the accounts a pool draws from.
 *
 * @category constructors
 * @since 1.0.0
 */
export const order = (
  accounts: ReadonlyArray<Account>,
  options: Options = {}
): ReadonlyArray<Rung> => {
  const providers = options.providers === "all"
    ? undefined
    : new Set(options.providers ?? defaultProviders)
  const matching = accounts.filter((account) => providers === undefined || providers.has(account.provider))
  if (matching.length === 0) return []

  const random = options.random ??
    (options.seed === undefined ? Math.random : seededRandom(options.seed))
  const tieOrder = options.shuffle === false ? matching : shuffled(matching, random)
  const tieBreak = new Map(tieOrder.map((account, index) => [account.label, index] as const))
  const modelFor = (account: Account): string | undefined =>
    options.models?.[account.provider] ?? account.model

  const quota = options.quota ?? {}
  const nowMs = options.nowMs ?? Date.now()
  const ordered = Selection.orderAccountsByUsage(matching, {
    quota,
    ...(options.reports === undefined ? {} : { reports: options.reports }),
    modelFor,
    tieBreak,
    nowMs
  })

  return ordered.map((account) => {
    const model = modelFor(account)
    const block = Selection.accountQuotaBlock(
      quota,
      account.label,
      model,
      options.reports?.[account.label],
      nowMs
    )
    return {
      account,
      ...(model === undefined ? {} : { model }),
      ...(block === undefined ? {} : { blockedUntilMs: block.untilMs })
    }
  })
}

/**
 * The first rung a caller may actually run, or `undefined` when every
 * account is blocked.
 *
 * @category getters
 * @since 1.0.0
 */
export const first = (
  rungs: ReadonlyArray<Rung>,
  nowMs: number = Date.now()
): Rung | undefined =>
  rungs.find((rung) => rung.blockedUntilMs === undefined || rung.blockedUntilMs <= nowMs)
